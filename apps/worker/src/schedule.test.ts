import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { agentRuns, outlets, pipelineJobs } from "@sisaku/db";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineRuns,
  createPipelineSchedule,
  createPipelineWorker,
  DEFAULT_STEPS,
  PermanentError,
  PIPELINE_QUEUE,
  queueOptions,
  type PipelineSteps,
} from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";
import { deleteRuns, expectStatus, readRun } from "./testing/runs";

// Asia/Jakarta is UTC+7 all year, so its 22:00 is 15:00Z.
const JAKARTA = "Asia/Jakarta";

describe.skipIf(!testDbUrl || !testRedisUrl)("pipeline schedule", { timeout: 15_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;
  let queue: Queue;
  let clock: Date;
  let logged: string[];
  let schedule: ReturnType<typeof createPipelineSchedule>;
  const workers: ReturnType<typeof createPipelineWorker>[] = [];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 20 });
    queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis));
    schedule = createPipelineSchedule({
      db,
      redis: redis.redis,
      runs,
      now: () => clock,
      log: (message) => logged.push(message),
    });
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop(500)));
    await redis.clear();
    await deleteRuns(db);
    await db.update(outlets).set({ timezone: JAKARTA });
  });
  afterAll(async () => {
    await schedule?.close();
    await runs?.close();
    await queue?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  /** Sets the time, and forgets what was logged before. */
  function at(time: string) {
    clock = new Date(time);
    logged = [];
  }

  function startWorker(steps: Partial<PipelineSteps> = {}) {
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      redis: redis.redis,
      schedule,
      steps: { ...DEFAULT_STEPS, ...steps },
      log: () => undefined,
    });
    workers.push(worker);
    return worker;
  }

  const allRuns = () => db.select().from(agentRuns);
  const started = async () =>
    (await allRuns())
      .map((run) => [run.outletId, run.businessDate, run.trigger] as const)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  const schedulers = async () =>
    (await queue.getJobSchedulers())
      .map(({ template, pattern, tz }) => ({ ...template?.data, pattern, tz }))
      .sort((a, b) => String(a.outletId).localeCompare(String(b.outletId)));

  describe("sync", () => {
    const scheduler = (outletId: string, tz = JAKARTA) => ({
      outletId,
      timezone: tz,
      pattern: "0 22 * * *",
      tz,
    });

    it("gives every outlet a 22:00 schedule in its own timezone", async () => {
      at("2026-03-01T05:00:00Z");
      await db
        .update(outlets)
        .set({ timezone: "America/New_York" })
        .where(eq(outlets.id, ids.outletB));
      await schedule.sync();
      expect(await schedulers()).toEqual([
        scheduler(ids.outletA),
        scheduler(ids.outletB, "America/New_York"),
      ]);
      for (const { next, tz } of await queue.getJobSchedulers()) {
        const local = new Date(next!).toLocaleTimeString("en-GB", { timeZone: tz! });
        expect(local).toBe("22:00:00");
      }
    });

    it("follows a timezone change, a new outlet and a deleted one", async () => {
      at("2026-03-01T05:00:00Z");
      const [added] = await db
        .insert(outlets)
        .values({ name: "Warung Baru" })
        .returning({ id: outlets.id });
      await schedule.sync();
      expect(await schedulers()).toHaveLength(3);

      await db.delete(outlets).where(eq(outlets.id, added!.id));
      await db
        .update(outlets)
        .set({ timezone: "Asia/Makassar" })
        .where(eq(outlets.id, ids.outletA));
      await schedule.sync();
      expect(await schedulers()).toEqual([
        scheduler(ids.outletA, "Asia/Makassar"),
        scheduler(ids.outletB),
      ]);
      // Nothing is left to start for the deleted outlet either.
      expect((await queue.getDelayed()).map((job) => job.data.outletId).sort()).toEqual([
        ids.outletA,
        ids.outletB,
      ]);
    });

    it("keeps a start that is due but not yet taken by a worker", async () => {
      at("2026-03-01T05:00:00Z");
      await schedule.sync();
      const due = (await queue.getDelayed()).find((job) => job.data.outletId === ids.outletA)!;
      await due.promote();
      await schedule.sync();
      expect((await queue.getWaiting()).map((job) => job.id)).toEqual([due.id]);
    });

    it("skips an outlet whose timezone does not exist, and says so", async () => {
      at("2026-03-01T16:00:00Z");
      await db.update(outlets).set({ timezone: "Mars/Base" }).where(eq(outlets.id, ids.outletA));
      await schedule.sync();
      expect((await schedulers()).map((s) => s.outletId)).toEqual([ids.outletB]);
      expect((await started()).map(([outletId]) => outletId)).toEqual([ids.outletB]);
      expect(logged.join("\n")).toMatch(new RegExp(`${ids.outletA}.*Mars/Base`));
    });
  });

  describe("a scheduled start", () => {
    it("runs the pipeline, for two outlets at the same moment", async () => {
      at("2026-03-01T05:00:00Z");
      await schedule.sync();
      const due = await queue.getDelayed();
      clock = new Date(Number(due[0]!.opts.prevMillis));
      startWorker();
      await Promise.all(due.map((job) => job.promote()));

      await expect.poll(async () => (await allRuns()).length).toBe(2);
      for (const run of await allRuns()) {
        expect(run.trigger).toBe("schedule");
        await expectStatus(db, run.id, "succeeded");
        expect((await readRun(db, run.id)).statuses).toEqual(Array(5).fill("succeeded"));
      }
      expect((await allRuns()).map((run) => run.outletId).sort()).toEqual([
        ids.outletA,
        ids.outletB,
      ]);
      // The next night is scheduled as well.
      await expect.poll(async () => (await queue.getDelayed()).length).toBe(2);
    });

    it.each([
      ["on time", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T15:00:00Z"],
      ["late the same evening", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T16:59:00Z"],
      ["just after midnight", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T17:10:00Z"],
      ["across midnight", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T18:30:00Z"],
      ["just before 06:00", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T22:59:59Z"],
      // A little early by this clock, which is not Redis's.
      ["early", JAKARTA, "2026-03-01T15:00:00Z", "2026-03-01T14:59:59Z"],
      // 22:00 in New York is already the next day in UTC; in Auckland it is still the morning.
      ["in New York", "America/New_York", "2026-03-02T03:00:00Z", "2026-03-02T06:30:00Z"],
      ["in Auckland", "Pacific/Auckland", "2026-03-01T09:00:00Z", "2026-03-01T13:30:00Z"],
    ])("covers the scheduled day when it starts %s", async (_when, timezone, due, now) => {
      at(now);
      await schedule.start({ outletId: ids.outletA, timezone }, new Date(due));
      expect(await started()).toEqual([[ids.outletA, "2026-03-01", "schedule"]]);
    });

    it.each([
      ["after 06:00", "2026-03-01T23:00:00Z"],
      ["the next evening", "2026-03-02T16:00:00Z"],
      ["days later", "2026-03-05T18:00:00Z"],
    ])("skips a night that is over when it is taken up %s, and says so", async (_when, now) => {
      at(now);
      const start = { outletId: ids.outletA, timezone: JAKARTA };
      await schedule.start(start, new Date("2026-03-01T15:00:00Z"));
      expect(await started()).toEqual([]);
      expect(logged.join()).toMatch(new RegExp(`2026-03-01.*${ids.outletA}.*skipped`));
    });

    it("creates one run however often it is repeated, also at the same moment", async () => {
      at("2026-03-01T15:00:00Z");
      const start = { outletId: ids.outletA, timezone: JAKARTA };
      await Promise.all(
        Array.from({ length: 5 }, () => schedule.start(start, new Date("2026-03-01T15:00:00Z"))),
      );
      const [run, ...others] = await allRuns();
      expect(others).toEqual([]);
      expect(await db.select().from(pipelineJobs)).toHaveLength(5);
      startWorker();
      await expectStatus(db, run!.id, "succeeded");
      await schedule.start(start, new Date("2026-03-01T15:00:00Z"));
      expect(await allRuns()).toHaveLength(1);
    });

    it("is not blocked by a manual run for that date", async () => {
      at("2026-03-01T15:00:00Z");
      await runs.startManual({ outlet: ids.outletA, date: "2026-03-01" });
      const start = { outletId: ids.outletA, timezone: JAKARTA };
      await schedule.start(start, new Date("2026-03-01T15:00:00Z"));
      expect((await started()).map(([, date, trigger]) => [date, trigger]).sort()).toEqual([
        ["2026-03-01", "manual"],
        ["2026-03-01", "schedule"],
      ]);
    });

    it("does nothing for an outlet deleted since", async () => {
      at("2026-03-01T15:00:00Z");
      const gone = "00000000-0000-4000-8000-0000000000ff";
      const start = { outletId: gone, timezone: JAKARTA };
      await schedule.start(start, new Date("2026-03-01T15:00:00Z"));
      expect(await started()).toEqual([]);
      expect(logged.join()).toContain(gone);
    });
  });

  describe("catch-up", () => {
    const missed = async (now: string) => {
      at(now);
      await schedule.sync();
      return started();
    };
    const both = (date: string) => [
      [ids.outletA, date, "schedule"],
      [ids.outletB, date, "schedule"],
    ];

    it.each([
      ["at 22:00", "2026-03-01T15:00:00Z", "2026-03-01"],
      ["at 23:30", "2026-03-01T16:30:00Z", "2026-03-01"],
      ["at 00:10", "2026-03-01T17:10:00Z", "2026-03-01"],
      ["at 02:00", "2026-03-01T19:00:00Z", "2026-03-01"],
      ["at 05:59", "2026-03-01T22:59:00Z", "2026-03-01"],
    ])("starts the missed night when the worker is back %s", async (_when, now, date) => {
      expect(await missed(now)).toEqual(both(date));
    });

    it.each([
      ["at 06:00", "2026-03-01T23:00:00Z"],
      ["at noon", "2026-03-02T05:00:00Z"],
      ["at 21:59", "2026-03-02T14:59:00Z"],
    ])("skips it when the worker is back %s, and says so", async (_when, now) => {
      expect(await missed(now)).toEqual([]);
      expect(logged.filter((line) => /2026-03-01.*skipped/.test(line))).toHaveLength(2);
    });

    it("uses each outlet's own time", async () => {
      await db
        .update(outlets)
        .set({ timezone: "America/New_York" })
        .where(eq(outlets.id, ids.outletB));
      // 02:00 in Jakarta, 14:00 in New York.
      expect(await missed("2026-03-01T19:00:00Z")).toEqual([
        [ids.outletA, "2026-03-01", "schedule"],
      ]);
      // 11:00 in Jakarta, 23:00 in New York, where it is still March 1.
      expect(await missed("2026-03-02T04:00:00Z")).toEqual([
        [ids.outletA, "2026-03-01", "schedule"],
        [ids.outletB, "2026-03-01", "schedule"],
      ]);
    });

    it("starts only the latest of several missed nights", async () => {
      await missed("2026-03-01T16:00:00Z");
      await missed("2026-03-06T16:00:00Z");
      expect((await started()).map(([, date]) => date).sort()).toEqual([
        "2026-03-01",
        "2026-03-01",
        "2026-03-06",
        "2026-03-06",
      ]);
    });

    it("does not start again a night that was run, or that failed", async () => {
      await missed("2026-03-01T15:30:00Z");
      const analyze = {
        name: "analyze" as const,
        output: z.unknown(),
        run: async () => {
          throw new PermanentError("no");
        },
      };
      startWorker({ analyze });
      for (const run of await allRuns()) await expectStatus(db, run.id, "failed");
      await workers.splice(0)[0]!.stop();
      expect(await missed("2026-03-01T17:00:00Z")).toHaveLength(2);
      // Nor does it call a night skipped that has its run.
      await missed("2026-03-02T05:00:00Z");
      expect(logged.join()).not.toContain("skipped");
    });

    it("queues a run again whose jobs never reached Redis", async () => {
      await missed("2026-03-01T15:30:00Z");
      await redis.clear();
      expect(await missed("2026-03-01T16:30:00Z")).toHaveLength(2);
      startWorker();
      for (const run of await allRuns()) await expectStatus(db, run.id, "succeeded");
    });
  });
});
