import {
  agentRuns,
  PIPELINE_STEPS,
  pipelineJobResults,
  pipelineJobs,
  type PipelineStep,
} from "@sisaku/db";
import { and, eq, inArray } from "drizzle-orm";
import { STEP_ATTEMPTS, type PipelineJobData } from "./queue";
import type { Db, Tx } from "./runs";
import { PermanentError } from "./steps";

// The steps of a run as Postgres records them. A step's record names its current attempt by when it
// started; a worker thought dead holds an older one, and can change nothing with it.

const LAST_STEP = PIPELINE_STEPS.at(-1);

/** One start of a step. `number` counts from the step's first start, or from its last retry by hand. */
export type Attempt = {
  readonly runId: string;
  readonly step: PipelineStep;
  readonly jobId: string;
  readonly number: number;
  readonly startedAt: Date;
};

/** `interrupted` is why the step itself is not started again, when only its fallback is left. */
export type StartedStep = { attempt: Attempt; interrupted?: PermanentError };

/** What an attempt made: its output as stored, and the writes of the step's own rows. */
export type Produced = { output: unknown; writes: readonly ((tx: Tx) => Promise<void>)[] };

/** Locks the step's record for the transaction. */
async function lockStep(tx: Tx, { runId, step }: PipelineJobData) {
  const [job] = await tx
    .select()
    .from(pipelineJobs)
    .where(and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, step)))
    .for("update");
  return job;
}

type StepRecord = NonNullable<Awaited<ReturnType<typeof lockStep>>>;

function isDone({ status }: StepRecord) {
  return status === "succeeded" || status === "degraded";
}

function isCurrent(job: StepRecord | undefined, attempt: Attempt) {
  return job?.startedAt?.getTime() === attempt.startedAt.getTime();
}

/**
 * Starts an attempt, or gives nothing when the step already has its result. A failed step starts
 * when its job is retried by hand: its attempts count anew, and its run is in progress again.
 *
 * A step that is still running was interrupted. If that was its 4th attempt it is not started
 * again: `interrupted` says so, and only its fallback is left.
 */
export async function startStep(
  db: Db,
  { runId, step }: PipelineJobData,
): Promise<StartedStep | undefined> {
  return db.transaction(async (tx) => {
    const job = await lockStep(tx, { runId, step });
    if (!job) throw new PermanentError(`Pipeline run ${runId} has no job for ${step}`);
    if (isDone(job)) return;

    const spent = job.status === "running" && job.attempts >= STEP_ATTEMPTS;
    const number = spent ? job.attempts : job.status === "failed" ? 1 : job.attempts + 1;
    const startedAt = new Date();
    await tx
      .update(pipelineJobs)
      .set({ status: "running", attempts: number, startedAt, finishedAt: null })
      .where(eq(pipelineJobs.id, job.id));
    await tx
      .update(agentRuns)
      .set({ status: "running", error: null, finishedAt: null })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "failed")));

    const attempt = { runId, step, jobId: job.id, number, startedAt };
    if (!spent) return { attempt };
    const before = job.error ? `; last error: ${job.error}` : "";
    const message = `Interrupted on attempt ${number} of ${STEP_ATTEMPTS}${before}`;
    return { attempt, interrupted: new PermanentError(message) };
  });
}

/** Saves the step's rows, result and status together, if the attempt is still the current one. */
export async function saveStep(
  db: Db,
  attempt: Attempt,
  { output, writes }: Produced,
  result: { status: "succeeded" } | { status: "degraded"; error: string },
): Promise<void> {
  const { runId, step, jobId } = attempt;
  await db.transaction(async (tx) => {
    const job = await lockStep(tx, attempt);
    if (!isCurrent(job, attempt) || job?.status !== "running") {
      throw new Error(`Attempt ${attempt.number} of ${step} in run ${runId} is not current`);
    }
    const finishedAt = new Date();
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

/**
 * Records that an attempt failed. Unless it was the last one the step is pending until its retry.
 * False if the attempt is not the current one.
 */
export async function recordAttemptError(
  db: Db,
  attempt: Attempt,
  { message, last }: { message: string; last: boolean },
): Promise<boolean> {
  const updated = await db
    .update(pipelineJobs)
    .set({ error: message, ...(last ? {} : { status: "pending" }) })
    .where(
      and(
        eq(pipelineJobs.id, attempt.jobId),
        eq(pipelineJobs.status, "running"),
        eq(pipelineJobs.startedAt, attempt.startedAt),
      ),
    )
    .returning({ id: pipelineJobs.id });
  return updated.length > 0;
}

/**
 * Records that BullMQ gave up on a step, which stops its run: the later steps wait for it. A step
 * that already has its result, or a run that already ended, keeps its status. With `attempt`, only
 * if no other one has started since, as a retry by hand does.
 */
export async function recordFailure(
  db: Db,
  { runId, step }: PipelineJobData,
  message: string,
  attempt?: Attempt,
): Promise<void> {
  const finishedAt = new Date();
  await db.transaction(async (tx) => {
    const job = await lockStep(tx, { runId, step });
    if (attempt && !isCurrent(job, attempt)) return;
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
