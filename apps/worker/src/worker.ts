import type { McpServer } from "@anvia/core/mcp";
import {
  agentRuns,
  outlets,
  PIPELINE_STEPS,
  pipelineJobResults,
  pipelineJobs,
  type PipelineStep,
} from "@sisaku/db";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import {
  PIPELINE_QUEUE,
  pipelineJobData,
  queueOptions,
  STEP_ATTEMPTS,
  type PipelineJobData,
  type PipelineRedis,
} from "./queue";
import {
  recordAttemptError,
  recordFailure,
  saveStep,
  startStep,
  type Attempt,
  type Produced,
  type StartedStep,
} from "./records";
import type { Db, Tx } from "./runs";
import {
  DEFAULT_STEPS,
  DEFAULT_TIME_LIMIT_MS,
  PermanentError,
  type PipelineRun,
  type PipelineSteps,
  type StepContext,
} from "./steps";
import { createPipelineTracer, type AttemptSpan, type PipelineLens } from "./trace";
import { START_JOB, type PipelineSchedule } from "./schedule";
import { within } from "./within";

export type PipelineWorkerDeps = {
  db: Db;
  servers: readonly McpServer[];
  redis: PipelineRedis;
  steps?: PipelineSteps;
  /** Left out, the worker executes runs but starts none. */
  schedule?: PipelineSchedule;
  /** Left out, runs are not traced. */
  lens?: PipelineLens;
  /** How long after a worker dies its step is taken over, at most twice this. Tests shorten it. */
  stalledAfterMs?: number;
  log?: (message: string, error?: unknown) => void;
};

const DEFAULT_STOP_WAIT_MS = 30_000;
const RECORD_WAIT_MS = 5_000;
const STALLED_AFTER_MS = 30_000;
/** Kills of a job after which not even its fallback is started: it may be what kills the worker. */
const MAX_KILLS = 2 * STEP_ATTEMPTS;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The error BullMQ does not retry after. */
function unrecoverable(error: unknown) {
  return Object.assign(new UnrecoverableError(messageOf(error)), {
    cause: error,
    ...(error instanceof Error && { stack: error.stack }),
  });
}

/**
 * Runs `work` until its time is up, whether or not it listens to the signal. Work that does not is
 * left behind, and what it returns later is dropped.
 */
async function withinTimeLimit<T>(
  step: PipelineStep,
  timeLimitMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(timeLimitMs);
  const timeUp = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true }),
  );
  try {
    // Async, so that work which throws at once is raced like any other.
    return await Promise.race([(async () => work(signal))(), timeUp]);
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Error(`Step ${step} reached its time limit of ${timeLimitMs} ms`, { cause: error });
  }
}

/** Executes pipeline runs, one BullMQ job per step. */
export function createPipelineWorker(deps: PipelineWorkerDeps) {
  const { db } = deps;
  const steps = deps.steps ?? DEFAULT_STEPS;
  const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));
  const tracer = createPipelineTracer(deps.lens, log);

  async function loadRun(runId: string) {
    const [run] = await db
      .select({
        id: agentRuns.id,
        outletId: outlets.id,
        timezone: outlets.timezone,
        businessDate: agentRuns.businessDate,
        traceId: agentRuns.traceId,
      })
      .from(agentRuns)
      .innerJoin(outlets, eq(outlets.id, agentRuns.outletId))
      .where(eq(agentRuns.id, runId));
    if (!run?.businessDate || !run.traceId) {
      throw new PermanentError(`Pipeline run ${runId} not found`);
    }
    return { ...run, businessDate: run.businessDate, traceId: run.traceId };
  }

  /** The outputs of the steps before this one. */
  async function loadOutputs(runId: string, step: PipelineStep) {
    const rows = await db
      .select({ step: pipelineJobs.step, output: pipelineJobResults.output })
      .from(pipelineJobResults)
      .innerJoin(pipelineJobs, eq(pipelineJobs.id, pipelineJobResults.jobId))
      .where(eq(pipelineJobs.runId, runId));
    const saved = new Map(rows.map((row) => [row.step, row.output]));
    const outputs: Partial<Record<PipelineStep, unknown>> = {};
    for (const earlier of PIPELINE_STEPS.slice(0, PIPELINE_STEPS.indexOf(step))) {
      if (!saved.has(earlier)) {
        throw new PermanentError(`Step ${earlier} of run ${runId} has no result`);
      }
      const output = steps[earlier].output.safeParse(saved.get(earlier));
      if (!output.success) {
        throw new PermanentError(
          `The saved output of ${earlier} does not match its schema: ${output.error.message}`,
        );
      }
      outputs[earlier] = output.data;
    }
    return outputs;
  }

  /**
   * The step's output as it is stored. It must match its schema after a round trip through JSON,
   * because that is how the steps after this one read it.
   */
  function toStored(step: PipelineStep, raw: unknown): unknown {
    const schema = steps[step].output;
    const stored: unknown = JSON.parse(JSON.stringify(schema.parse(raw)));
    schema.parse(stored);
    return stored;
  }

  /** The attempt a BullMQ job is on, for the `failed` event. */
  const attempts = new WeakMap<Job, Attempt>();

  /** One attempt of one step, as a span in the run's trace. */
  async function runStep(job: Job<PipelineJobData>): Promise<void> {
    const valid = pipelineJobData.safeParse(job.data);
    if (!valid.success) throw new PermanentError(`Not a pipeline job: ${valid.error.message}`);
    const { traceId, ...run } = await loadRun(valid.data.runId);
    const started = await startStep(db, valid.data);
    if (!started) return;
    attempts.set(job, started.attempt);
    const span = await tracer.start(run, traceId, started.attempt);
    try {
      const outcome = await runAttempt(job, run, started, span);
      if (outcome.status === "degraded") span.fail(outcome.error);
      else span.end();
    } catch (error) {
      span.fail(error);
      throw error;
    }
  }

  /**
   * The work first, then the save; the fallback once the step's attempts have run out.
   */
  async function runAttempt(
    job: Job<PipelineJobData>,
    run: PipelineRun,
    { attempt, interrupted }: StartedStep,
    span: AttemptSpan,
  ): Promise<{ status: "succeeded" } | { status: "degraded"; error: unknown }> {
    const { runId, step } = attempt;
    const definition = steps[step];
    async function produce(work: (context: StepContext) => Promise<unknown>): Promise<Produced> {
      const outputs = await loadOutputs(runId, step);
      const writes: ((tx: Tx) => Promise<void>)[] = [];
      const raw = await withinTimeLimit(
        step,
        definition.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
        (signal) =>
          work({
            run,
            outputs,
            servers: deps.servers,
            trace: span.trace,
            observability: span.observability,
            signal,
            onSave: (write) => void writes.push(write),
          }),
      );
      return { output: toStored(step, raw), writes };
    }

    let lastError: unknown = interrupted;
    if (!interrupted) {
      try {
        const produced = await produce((context) => definition.run(context));
        await saveStep(db, attempt, produced, { status: "succeeded" });
        return { status: "succeeded" };
      } catch (error) {
        // BullMQ counts failures only, the record counts kills too.
        const last =
          error instanceof PermanentError ||
          attempt.number >= STEP_ATTEMPTS ||
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const current = await recordAttemptError(db, attempt, {
          message: messageOf(error),
          last,
        }).catch((failure: unknown) => {
          log(`Could not record an error of ${step} in run ${runId}`, failure);
          return true;
        });
        if (!last || !current) throw error;
        lastError = error;
      }
    }

    const { fallback } = definition;
    if (!fallback) throw unrecoverable(lastError);
    log(`Step ${step} of run ${runId} uses its fallback`, lastError);
    const message = messageOf(lastError);
    try {
      if (interrupted && job.stalledCounter >= MAX_KILLS) throw new Error("interrupted too often");
      const produced = await produce((context) => fallback(context, lastError));
      await saveStep(db, attempt, produced, { status: "degraded", error: message });
      return { status: "degraded", error: lastError };
    } catch (error) {
      log(`The fallback of ${step} in run ${runId} failed`, error);
      throw new PermanentError(`${message}; its fallback failed: ${messageOf(error)}`);
    }
  }

  async function processJob(job: Job<PipelineJobData>) {
    try {
      if (deps.schedule && job.name === START_JOB) await deps.schedule.process(job);
      else await runStep(job);
    } catch (error) {
      throw error instanceof PermanentError ? unrecoverable(error) : error;
    }
  }

  const worker = new Worker<PipelineJobData, void, string>(PIPELINE_QUEUE, processJob, {
    ...queueOptions(deps.redis),
    concurrency: 2,
    lockDuration: deps.stalledAfterMs ?? STALLED_AFTER_MS,
    stalledInterval: deps.stalledAfterMs ?? STALLED_AFTER_MS,
    // BullMQ would fail the job without calling our code, which could not use the step's fallback.
    // The step's record counts the kills instead.
    maxStalledCount: Number.MAX_SAFE_INTEGER,
  });
  worker.on("error", (error) => log("Pipeline worker error", error));
  // Emitted only by the worker that holds the job, so a worker thought dead records nothing.
  const recording = new Set<Promise<void>>();
  worker.on("failed", (job, error) => {
    log(`Pipeline job ${job?.id} failed`, error);
    // BullMQ sets `finishedOn` only when it will not try again. Attempts left do not tell: a
    // permanent error ends the job early.
    if (!job?.finishedOn || !pipelineJobData.safeParse(job.data).success) return;
    const { runId, step } = job.data;
    const done = recordFailure(db, job.data, error.message, attempts.get(job))
      .catch((failure: unknown) =>
        log(`Could not record the failure of ${step} in run ${runId}`, failure),
      )
      .finally(() => recording.delete(done));
    recording.add(done);
  });

  return {
    /**
     * Takes no new jobs and waits for the current steps. A step still running after `waitMs` is
     * left behind: its job stalls, and another worker runs that step again.
     */
    async stop(waitMs = DEFAULT_STOP_WAIT_MS): Promise<void> {
      const paused = await within(
        waitMs,
        worker.pause().then(() => true),
      );
      const timedOut = !paused;
      if (timedOut) log(`Stopped with a step still running after ${waitMs} ms`);
      await worker.close(timedOut);
      await within(RECORD_WAIT_MS, Promise.all(recording));
      await tracer.close();
    },
  };
}
