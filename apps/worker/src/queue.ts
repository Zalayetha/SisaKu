import { PIPELINE_STEPS, type PipelineStep } from "@sisaku/db";
import { FlowProducer, Queue, type FlowJob } from "bullmq";
import * as z from "zod";

/** One queue for every step, so Bull Board shows a run as one tree (ADR 0017). */
export const PIPELINE_QUEUE = "nightly-pipeline";

/** How long finished jobs stay in Redis. Postgres keeps the history. */
const KEEP_FINISHED_SECONDS = 14 * 24 * 60 * 60;

/** One attempt and three retries, 30, 60 and 120 seconds apart. */
export const STEP_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30_000;

/** Where the queue lives. `prefix` keeps tests apart; production uses BullMQ's default. */
export type PipelineRedis = { url: string; prefix?: string };

/** Everything a job carries: the rest is read from Postgres. */
export const pipelineJobData = z.object({ runId: z.uuid(), step: z.enum(PIPELINE_STEPS) });
export type PipelineJobData = z.infer<typeof pipelineJobData>;

export type RunQueueState =
  | { type: "missing" }
  | { type: "failed"; step: PipelineStep; reason: string }
  | { type: "queued" };

export function queueOptions({ url, prefix }: PipelineRedis) {
  return { connection: { url }, ...(prefix ? { prefix } : {}) };
}

function jobId(runId: string, step: PipelineStep) {
  return `${runId}-${step}`;
}

/** The run as nested jobs: a step waits for its child, the step before it. */
function runFlow(runId: string, retryDelayMs: number): FlowJob {
  let flow: FlowJob | undefined;
  for (const step of PIPELINE_STEPS) {
    flow = {
      name: step,
      queueName: PIPELINE_QUEUE,
      data: { runId, step } satisfies PipelineJobData,
      opts: {
        jobId: jobId(runId, step),
        attempts: STEP_ATTEMPTS,
        backoff: { type: "exponential", delay: retryDelayMs },
        removeOnComplete: { age: KEEP_FINISHED_SECONDS },
        removeOnFail: { age: KEEP_FINISHED_SECONDS },
      },
      ...(flow ? { children: [flow] } : {}),
    };
  }
  return flow!;
}

/** Puts pipeline runs on the queue. `retryDelayMs` is the wait before the first retry. */
export function createPipelineQueue(redis: PipelineRedis, retryDelayMs = RETRY_DELAY_MS) {
  const queue = new Queue(PIPELINE_QUEUE, queueOptions(redis));
  const flows = new FlowProducer(queueOptions(redis));
  const lastStep = PIPELINE_STEPS.at(-1)!;
  return {
    /**
     * What Redis knows of the run: nothing, a step BullMQ gave up on, or jobs that will still run.
     * A run's jobs are added together, so the last step stands for all of them.
     */
    async state(runId: string): Promise<RunQueueState> {
      if (!(await queue.getJob(jobId(runId, lastStep)))) return { type: "missing" };
      for (const step of PIPELINE_STEPS) {
        const job = await queue.getJob(jobId(runId, step));
        if (job && (await job.isFailed())) {
          return { type: "failed", step, reason: job.failedReason ?? "unknown error" };
        }
      }
      return { type: "queued" };
    },
    async add(runId: string): Promise<void> {
      await flows.add(runFlow(runId, retryDelayMs));
    },
    async close(): Promise<void> {
      await Promise.all([flows.close(), queue.close()]);
    },
  };
}
