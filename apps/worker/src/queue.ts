import { PIPELINE_STEPS, type PipelineStep } from "@sisaku/db";
import { FlowProducer, Queue, type FlowJob } from "bullmq";

/** One queue for every step, so Bull Board shows a run as one tree (ADR 0017). */
export const PIPELINE_QUEUE = "nightly-pipeline";

/** How long finished jobs stay in Redis. Postgres keeps the history. */
const KEEP_FINISHED_SECONDS = 14 * 24 * 60 * 60;

/** Where the queue lives. `prefix` keeps tests apart; production uses BullMQ's default. */
export type PipelineRedis = { url: string; prefix?: string };

/** Everything a job carries: the rest is read from Postgres. */
export type PipelineJobData = { runId: string; step: PipelineStep };

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
function runFlow(runId: string): FlowJob {
  let flow: FlowJob | undefined;
  for (const step of PIPELINE_STEPS) {
    flow = {
      name: step,
      queueName: PIPELINE_QUEUE,
      data: { runId, step } satisfies PipelineJobData,
      opts: {
        jobId: jobId(runId, step),
        removeOnComplete: { age: KEEP_FINISHED_SECONDS },
        removeOnFail: { age: KEEP_FINISHED_SECONDS },
      },
      ...(flow ? { children: [flow] } : {}),
    };
  }
  return flow!;
}

/** Puts pipeline runs on the queue. */
export function createPipelineQueue(redis: PipelineRedis) {
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
      await flows.add(runFlow(runId));
    },
    async close(): Promise<void> {
      await Promise.all([flows.close(), queue.close()]);
    },
  };
}
