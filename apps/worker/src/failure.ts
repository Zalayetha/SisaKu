import { agentRuns, pipelineJobs } from "@sisaku/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PipelineJobData } from "./queue";
import type { Db } from "./runs";

/**
 * Records that BullMQ gave up on a step, which stops its run: the later steps wait for it. A step
 * that already has its result, or a run that already ended, keeps its status.
 */
export async function recordFailure(
  db: Db,
  { runId, step }: PipelineJobData,
  message: string,
): Promise<void> {
  const finishedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(pipelineJobs)
      .set({ status: "failed", error: message, finishedAt })
      .where(
        and(
          eq(pipelineJobs.runId, runId),
          eq(pipelineJobs.step, step),
          inArray(pipelineJobs.status, ["pending", "running"]),
        ),
      );
    await tx
      .update(agentRuns)
      .set({ status: "failed", error: `${step}: ${message}`, finishedAt })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
  });
}

/**
 * Records an attempt that failed. Unless it was the last one, the step is pending until its retry:
 * a step still running when a worker takes it up was interrupted. An attempt that is no longer the
 * current one, because its worker was thought dead, changes nothing.
 */
export async function recordAttemptError(
  db: Db,
  { runId, step }: PipelineJobData,
  { attempt, message, last }: { attempt: number; message: string; last: boolean },
): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({ error: message, ...(last ? {} : { status: "pending" }) })
    .where(
      and(
        eq(pipelineJobs.runId, runId),
        eq(pipelineJobs.step, step),
        eq(pipelineJobs.status, "running"),
        eq(pipelineJobs.attempts, attempt),
      ),
    );
}
