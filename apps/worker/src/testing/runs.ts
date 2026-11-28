import { agentRuns, forecasts, pipelineJobResults, pipelineJobs, PIPELINE_STEPS } from "@sisaku/db";
import type { PipelineStep } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { Db } from "../runs";

// Test-only: a pipeline run as Postgres has it.

export async function readRun(db: Db, runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  const rows = await db
    .select()
    .from(pipelineJobs)
    .leftJoin(pipelineJobResults, eq(pipelineJobResults.jobId, pipelineJobs.id))
    .where(eq(pipelineJobs.runId, runId));
  const job = (step: PipelineStep) => {
    const row = rows.find((r) => r.pipeline_jobs.step === step)!;
    return { ...row.pipeline_jobs, output: row.pipeline_job_results?.output };
  };
  const jobs = PIPELINE_STEPS.map(job);
  return { run: run!, job, jobs, statuses: jobs.map(({ status }) => status) };
}

/** Waits until the run has the status. */
export async function expectStatus(
  db: Db,
  runId: string,
  status: "succeeded" | "failed",
  timeout = 10_000,
) {
  await expect.poll(async () => (await readRun(db, runId)).run.status, { timeout }).toBe(status);
}

export async function deleteRuns(db: Db) {
  await db.delete(forecasts);
  await db.delete(pipelineJobResults);
  await db.delete(pipelineJobs);
  await db.delete(agentRuns);
}
