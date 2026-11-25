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
import { and, eq } from "drizzle-orm";
import { recordAttemptError, recordFailure } from "./failure";
import {
  PIPELINE_QUEUE,
  pipelineJobData,
  queueOptions,
  STEP_ATTEMPTS,
  type PipelineJobData,
  type PipelineRedis,
} from "./queue";
import type { Db, Tx } from "./runs";
import {
  DEFAULT_STEPS,
  DEFAULT_TIME_LIMIT_MS,
  PermanentError,
  type PipelineSteps,
  type StepContext,
} from "./steps";

export type PipelineWorkerDeps = {
  db: Db;
  servers: readonly McpServer[];
  redis: PipelineRedis;
  steps?: PipelineSteps;
  /** How long after a worker dies its step is taken over, at most twice this. Tests shorten it. */
  stalledAfterMs?: number;
  log?: (message: string, error?: unknown) => void;
};

/** What an attempt made: its output as stored, and the writes of the step's own rows. */
type Produced = { output: unknown; writes: ((tx: Tx) => Promise<void>)[] };

const DEFAULT_STOP_WAIT_MS = 30_000;
const STALLED_AFTER_MS = 30_000;
const LAST_STEP = PIPELINE_STEPS.at(-1);

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether BullMQ will not try the job again after this error. */
function isLastAttempt(job: Job, error: unknown) {
  return error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
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

  /**
   * Starts an attempt, or gives nothing when the step already has its result. A failed step starts
   * again when its job is retried, and its run is in progress again. `kills` is how often a worker
   * died while it ran the job; after too many of them the step is not started.
   */
  async function startStep({ runId, step }: PipelineJobData, kills: number) {
    return db.transaction(async (tx) => {
      const [job] = await tx
        .select({
          id: pipelineJobs.id,
          status: pipelineJobs.status,
          attempts: pipelineJobs.attempts,
        })
        .from(pipelineJobs)
        .where(and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, step)))
        .for("update");
      if (!job) throw new PermanentError(`Pipeline run ${runId} has no job for ${step}`);
      if (job.status === "succeeded" || job.status === "degraded") return;
      // Still running means interrupted. Kills before a retry by an operator do not count again.
      if (job.status === "running" && kills >= STEP_ATTEMPTS) {
        return { id: job.id, attempt: job.attempts, killed: true };
      }
      const attempt = job.attempts + 1;
      await tx
        .update(pipelineJobs)
        .set({ status: "running", attempts: attempt, startedAt: new Date(), finishedAt: null })
        .where(eq(pipelineJobs.id, job.id));
      await tx
        .update(agentRuns)
        .set({ status: "running", error: null, finishedAt: null })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "failed")));
      return { id: job.id, attempt, killed: false };
    });
  }

  /** Saves the step's result and status together. */
  async function saveStep(
    { runId, step }: PipelineJobData,
    jobId: string,
    { output, writes }: Produced,
    result: { status: "succeeded" } | { status: "degraded"; error: string },
  ) {
    await db.transaction(async (tx) => {
      const finishedAt = new Date();
      // A worker thought dead may finish late. What was recorded first stands: another worker's
      // result, or the step's failure.
      const [current] = await tx
        .select({ status: pipelineJobs.status })
        .from(pipelineJobs)
        .where(eq(pipelineJobs.id, jobId))
        .for("update");
      if (current?.status !== "running") return;
      for (const write of writes) await write(tx);
      await tx.insert(pipelineJobResults).values({ jobId, output });
      await tx
        .update(pipelineJobs)
        .set({ ...result, finishedAt })
        .where(eq(pipelineJobs.id, jobId));
      if (step === LAST_STEP) {
        await tx
          .update(agentRuns)
          .set({ status: "succeeded", error: null, finishedAt })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
      }
    });
  }

  /** One attempt of one step: the work first, then the save. */
  async function runStep(job: Job<PipelineJobData>): Promise<void> {
    const valid = pipelineJobData.safeParse(job.data);
    if (!valid.success) throw new PermanentError(`Not a pipeline job: ${valid.error.message}`);
    const { runId, step } = valid.data;
    const { traceId, ...run } = await loadRun(runId);
    const started = await startStep(valid.data, job.stalledCounter);
    if (!started) return;

    const definition = steps[step];
    const outputs = await loadOutputs(runId, step);
    const produce = async (work: (context: StepContext) => Promise<unknown>): Promise<Produced> => {
      const writes: Produced["writes"] = [];
      const raw = await withinTimeLimit(
        step,
        definition.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
        (signal) =>
          work({
            run,
            outputs,
            servers: deps.servers,
            trace: { traceId },
            signal,
            onSave: (write) => void writes.push(write),
          }),
      );
      return { output: toStored(step, raw), writes };
    };

    try {
      if (started.killed) {
        throw new PermanentError(`Its worker died ${STEP_ATTEMPTS} times while running it`);
      }
      const produced = await produce((context) => definition.run(context));
      await saveStep(valid.data, started.id, produced, { status: "succeeded" });
    } catch (error) {
      const message = messageOf(error);
      const last = isLastAttempt(job, error);
      await recordAttemptError(db, valid.data, { attempt: started.attempt, message, last }).catch(
        (failure: unknown) => log(`Could not record an error of ${step} in run ${runId}`, failure),
      );
      const { fallback } = definition;
      if (!fallback || !last) throw error;
      log(`Step ${step} of run ${runId} uses its fallback`, error);
      try {
        // The fallback may be what kills the worker, so it is not started forever either.
        if (job.stalledCounter >= 2 * STEP_ATTEMPTS) {
          throw new Error(`its worker died ${STEP_ATTEMPTS} times`);
        }
        const produced = await produce((context) => fallback(context, error));
        await saveStep(valid.data, started.id, produced, { status: "degraded", error: message });
      } catch (fallbackError) {
        log(`The fallback of ${step} in run ${runId} failed`, fallbackError);
        throw new PermanentError(`${message}; its fallback failed: ${messageOf(fallbackError)}`);
      }
    }
  }

  const worker = new Worker<PipelineJobData, void, PipelineStep>(PIPELINE_QUEUE, runStep, {
    ...queueOptions(deps.redis),
    concurrency: 2,
    lockDuration: deps.stalledAfterMs ?? STALLED_AFTER_MS,
    stalledInterval: deps.stalledAfterMs ?? STALLED_AFTER_MS,
    // BullMQ would fail the job without calling `runStep`, so `runStep` counts the kills itself:
    // only it can use the step's fallback.
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
    const done = recordFailure(db, job.data, error.message)
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
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        worker.pause().then(() => false),
        new Promise<true>((resolve) => (timer = setTimeout(resolve, waitMs, true))),
      ]);
      clearTimeout(timer);
      if (timedOut) log(`Stopped with a step still running after ${waitMs} ms`);
      await worker.close(timedOut);
      await Promise.all(recording);
    },
  };
}
