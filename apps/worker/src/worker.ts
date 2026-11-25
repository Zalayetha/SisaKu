import type { McpServer } from "@anvia/core/mcp";
import {
  agentRuns,
  outlets,
  PIPELINE_STEPS,
  pipelineJobResults,
  pipelineJobs,
  type PipelineStep,
} from "@sisaku/db";
import { Worker } from "bullmq";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { recordFailure } from "./failure";
import { PIPELINE_QUEUE, queueOptions, type PipelineJobData, type PipelineRedis } from "./queue";
import type { Db } from "./runs";
import { DEFAULT_STEPS, DEFAULT_TIME_LIMIT_MS, type PipelineSteps } from "./steps";

export type PipelineWorkerDeps = {
  db: Db;
  servers: readonly McpServer[];
  redis: PipelineRedis;
  steps?: PipelineSteps;
  log?: (message: string, error?: unknown) => void;
};

const DEFAULT_STOP_WAIT_MS = 30_000;
const LAST_STEP = PIPELINE_STEPS.at(-1);

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
    if (!run?.businessDate || !run.traceId) throw new Error(`Pipeline run ${runId} not found`);
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
      if (!saved.has(earlier)) throw new Error(`Step ${earlier} of run ${runId} has no result`);
      outputs[earlier] = steps[earlier].output.parse(saved.get(earlier));
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

  /** Does the work first, then saves the result and the status together. */
  async function runStep({ runId, step }: PipelineJobData): Promise<void> {
    const { traceId, ...run } = await loadRun(runId);
    const ofStep = and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, step));
    const [job] = await db
      .update(pipelineJobs)
      .set({
        status: "running",
        attempts: sql`${pipelineJobs.attempts} + 1`,
        startedAt: new Date(),
      })
      .where(and(ofStep, notInArray(pipelineJobs.status, ["succeeded", "degraded"])))
      .returning({ id: pipelineJobs.id });
    if (!job) return; // It already has its result, which was saved with this status.

    const definition = steps[step];
    const raw = await definition.run({
      run,
      outputs: await loadOutputs(runId, step),
      servers: deps.servers,
      trace: { traceId },
      signal: AbortSignal.timeout(definition.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS),
    });
    const output = toStored(step, raw);
    await db.transaction(async (tx) => {
      const finishedAt = new Date();
      // A worker thought dead may finish the same step later; the first result stands.
      const saved = await tx
        .insert(pipelineJobResults)
        .values({ jobId: job.id, output })
        .onConflictDoNothing({ target: pipelineJobResults.jobId })
        .returning({ id: pipelineJobResults.id });
      if (saved.length === 0) return;
      await tx
        .update(pipelineJobs)
        .set({ status: "succeeded", error: null, finishedAt })
        .where(ofStep);
      if (step === LAST_STEP) {
        await tx
          .update(agentRuns)
          .set({ status: "succeeded", error: null, finishedAt })
          .where(eq(agentRuns.id, runId));
      }
    });
  }

  const worker = new Worker<PipelineJobData, void, PipelineStep>(
    PIPELINE_QUEUE,
    (job) => runStep(job.data),
    { ...queueOptions(deps.redis), concurrency: 2 },
  );
  worker.on("error", (error) => log("Pipeline worker error", error));
  // Also emitted for a job BullMQ fails without calling `runStep` (it stalled too often), and only
  // by the worker that holds the job, so a worker thought dead records nothing.
  const recording = new Set<Promise<void>>();
  worker.on("failed", (job, error) => {
    log(`Pipeline job ${job?.id} failed`, error);
    if (!job) return;
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
