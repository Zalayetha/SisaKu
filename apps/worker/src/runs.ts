import { randomBytes } from "node:crypto";
import {
  agentRuns,
  NIGHTLY_PIPELINE_AGENT,
  outlets,
  PIPELINE_STEPS,
  pipelineJobs,
  type createDb,
} from "@sisaku/db";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { recordFailure } from "./records";
import { createPipelineQueue, type PipelineRedis } from "./queue";

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A run that was asked for but must not start. Its message is for the person asking. */
export class RunRefused extends Error {}

const isoDate = z.iso.date();
const uuid = z.uuid();

export type PipelineRunsDeps = {
  db: Db;
  redis: PipelineRedis;
  /** The wait before a step's first retry, doubled for each one after. Tests shorten it. */
  retryDelayMs?: number;
};

/** Creates pipeline runs. A worker executes them. */
export function createPipelineRuns({ db, redis, retryDelayMs }: PipelineRunsDeps) {
  const queue = createPipelineQueue(redis, retryDelayMs);

  async function findOutlet(idOrName: string): Promise<string> {
    const found = await db
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        uuid.safeParse(idOrName).success
          ? eq(outlets.id, idOrName)
          : eq(sql`lower(${outlets.name})`, idOrName.toLowerCase()),
      );
    if (found.length === 0) throw new RunRefused(`No outlet with the id or name "${idOrName}"`);
    if (found.length > 1) {
      const all = found.map((outlet) => outlet.id).join(", ");
      throw new RunRefused(`${found.length} outlets are named "${idOrName}", use the id: ${all}`);
    }
    return found[0]!.id;
  }

  /** The run in progress for the outlet and date, or a new manual one. */
  async function findOrCreate(outletId: string, date: string) {
    return db.transaction(async (tx) => {
      // One creation at a time per outlet, without blocking rows that only reference it.
      await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(eq(outlets.id, outletId))
        .for("no key update");
      const [inProgress] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.agent, NIGHTLY_PIPELINE_AGENT),
            eq(agentRuns.outletId, outletId),
            eq(agentRuns.businessDate, date),
            eq(agentRuns.status, "running"),
          ),
        );
      if (inProgress) return { id: inProgress.id, created: false };

      const [created] = await tx
        .insert(agentRuns)
        .values({
          agent: NIGHTLY_PIPELINE_AGENT,
          trigger: "manual",
          outletId,
          businessDate: date,
          traceId: randomBytes(16).toString("hex"),
        })
        .returning({ id: agentRuns.id });
      const runId = created!.id;
      await tx.insert(pipelineJobs).values(PIPELINE_STEPS.map((step) => ({ runId, step })));
      return { id: runId, created: true };
    });
  }

  return {
    /**
     * Starts a run by hand for one outlet (id or name) and business date. Repeats are allowed, one
     * at a time. A run in progress whose jobs are not in Redis (its creation was interrupted, or
     * Redis was emptied) is queued again instead of refused; its finished steps are kept. One that
     * BullMQ gave up on without the failure reaching Postgres is recorded as failed, and replaced.
     */
    async startManual(request: { outlet: string; date: string }): Promise<{ runId: string }> {
      const { date } = request;
      if (!isoDate.safeParse(date).success) {
        throw new RunRefused(`"${date}" is not a date, use --date YYYY-MM-DD`);
      }
      const outletId = await findOutlet(request.outlet);

      let run = await findOrCreate(outletId, date);
      if (!run.created) {
        const state = await queue.state(run.id);
        if (state.type === "queued") {
          throw new RunRefused(`Run ${run.id} for this outlet and date is already in progress`);
        }
        if (state.type === "failed") {
          await recordFailure(db, { runId: run.id, step: state.step }, state.reason);
          run = await findOrCreate(outletId, date);
        }
      }
      await queue.add(run.id);
      return { runId: run.id };
    },
    close: () => queue.close(),
  };
}
