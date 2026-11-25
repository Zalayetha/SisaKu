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
import { and, eq, sql } from "drizzle-orm";
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

  async function hasResult(runId: string, step: PipelineStep): Promise<boolean> {
    const rows = await db
      .select({ id: pipelineJobResults.id })
      .from(pipelineJobResults)
      .innerJoin(pipelineJobs, eq(pipelineJobs.id, pipelineJobResults.jobId))
      .where(and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, step)));
    return rows.length > 0;
  }

  /** Does the work first, then saves the result and the status together. */
  async function executeStep({ runId, step }: PipelineJobData): Promise<void> {
    const { traceId, ...run } = await loadRun(runId);
    if (await hasResult(runId, step)) return;
    const ofStep = and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, step));
    const [job] = await db
      .update(pipelineJobs)
      .set({
        status: "running",
        attempts: sql`${pipelineJobs.attempts} + 1`,
        startedAt: new Date(),
      })
      .where(ofStep)
      .returning({ id: pipelineJobs.id });

    const definition = steps[step];
    const output = definition.output.parse(
      await definition.run({
        run,
        outputs: await loadOutputs(runId, step),
        servers: deps.servers,
        trace: { traceId },
        signal: AbortSignal.timeout(definition.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS),
      }),
    );
    await db.transaction(async (tx) => {
      const finishedAt = new Date();
      // A worker thought dead may finish the same step later; the first result stands.
      const saved = await tx
        .insert(pipelineJobResults)
        .values({ jobId: job!.id, output })
        .onConflictDoNothing({ target: pipelineJobResults.jobId })
        .returning({ id: pipelineJobResults.id });
      if (saved.length === 0) return;
      await tx.update(pipelineJobs).set({ status: "succeeded", finishedAt }).where(ofStep);
      if (step === LAST_STEP) {
        await tx
          .update(agentRuns)
          .set({ status: "succeeded", finishedAt })
          .where(eq(agentRuns.id, runId));
      }
    });
  }

  /** Stops the run at this step. A step that already has its result is left alone. */
  async function recordFailure({ runId, step }: PipelineJobData, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await db.transaction(async (tx) => {
      const failed = await tx
        .update(pipelineJobs)
        .set({ status: "failed", error: message, finishedAt })
        .where(
          and(
            eq(pipelineJobs.runId, runId),
            eq(pipelineJobs.step, step),
            eq(pipelineJobs.status, "running"),
          ),
        )
        .returning({ id: pipelineJobs.id });
      if (failed.length === 0) return;
      await tx
        .update(agentRuns)
        .set({ status: "failed", error: `${step}: ${message}`, finishedAt })
        .where(eq(agentRuns.id, runId));
    });
  }

  async function runStep(data: PipelineJobData): Promise<void> {
    try {
      await executeStep(data);
    } catch (error) {
      await recordFailure(data, error).catch((failure: unknown) =>
        log(`Could not record the failure of ${data.step} in run ${data.runId}`, failure),
      );
      throw error;
    }
  }

  const worker = new Worker<PipelineJobData, void, PipelineStep>(
    PIPELINE_QUEUE,
    (job) => runStep(job.data),
    { ...queueOptions(deps.redis), concurrency: 2 },
  );
  worker.on("error", (error) => log("Pipeline worker error", error));
  worker.on("failed", (job, error) => log(`Pipeline job ${job?.id} failed`, error));

  return {
    /**
     * Takes no new jobs and waits for the current ones. A step still running after `waitMs` is
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
    },
  };
}
