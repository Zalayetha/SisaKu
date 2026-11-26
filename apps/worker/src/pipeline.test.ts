import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { agentRuns, createDb, outlets, pipelineJobs } from "@sisaku/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import * as z from "zod";
import {
  createPipelineRuns,
  createPipelineWorker,
  DEFAULT_STEPS,
  type PipelineWorkerDeps,
  type StepContext,
  type StepDefinition,
} from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";
import {
  deleteRuns,
  expectStatus as expectRunStatus,
  readRun as readRunFrom,
} from "./testing/runs";

const DATE = "2026-03-01";

describe.skipIf(!testDbUrl || !testRedisUrl)("nightly pipeline", () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;
  const workers: ReturnType<typeof createPipelineWorker>[] = [];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 20 });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    await redis.clear();
    await deleteRuns(db);
  });

  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  function startWorker(extra: Partial<PipelineWorkerDeps> = {}) {
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      redis: redis.redis,
      log: () => undefined,
      ...extra,
    });
    workers.push(worker);
    return worker;
  }

  /** A step that runs until `release` is called, and counts how often it started. */
  function blockingStep(name: StepDefinition["name"]) {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const started = { count: 0 };
    const step: StepDefinition = {
      name,
      output: z.object({ done: z.literal(true) }),
      run: async () => {
        started.count++;
        await released;
        return { done: true };
      },
    };
    return { step, release, started };
  }

  function countingStep(name: StepDefinition["name"]) {
    const started = { count: 0 };
    const step: StepDefinition = {
      name,
      output: z.object({ done: z.literal(true) }),
      run: async () => {
        started.count++;
        return { done: true };
      },
    };
    return { step, started };
  }

  const readRun = (runId: string) => readRunFrom(db, runId);
  const expectStatus = (runId: string, status: "succeeded" | "failed") =>
    expectRunStatus(db, runId, status);

  it("takes a manual run through all five steps", async () => {
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker();

    await expectStatus(runId, "succeeded");
    const { run, jobs } = await readRun(runId);
    expect(run).toMatchObject({
      agent: "nightly-pipeline",
      trigger: "manual",
      outletId: ids.outletA,
      businessDate: DATE,
      error: null,
      costUsd: null,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      finishedAt: expect.any(Date),
    });
    expect(jobs.map((j) => [j.step, j.status, j.attempts, j.output])).toEqual([
      ["ingest", "succeeded", 1, expect.objectContaining({ gaps: [] })],
      ["analyze", "succeeded", 1, expect.objectContaining({ spikes: [] })],
      ["forecast", "succeeded", 1, { stub: true }],
      ["recommend", "succeeded", 1, { stub: true }],
      ["report", "succeeded", 1, { stub: true }],
    ]);
    for (const job of jobs) {
      expect(job.startedAt).toBeInstanceOf(Date);
      expect(job.finishedAt).toBeInstanceOf(Date);
    }
  });

  it("gives a step its run, the outputs of earlier steps, the MCP servers and the run's trace", async () => {
    let seen: StepContext | undefined;
    const ingest: StepDefinition = {
      name: "ingest",
      // Zod drops what the schema does not declare, so this is what later steps read.
      output: z.object({ portions: z.number() }),
      run: async () => ({ portions: 512, scratch: "not part of the output" }),
    };
    const forecast: StepDefinition = {
      name: "forecast",
      output: z.object({ items: z.number() }),
      run: async (context) => {
        seen = context;
        return { items: 2 };
      },
    };
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps: { ...DEFAULT_STEPS, ingest, forecast } });

    await expectStatus(runId, "succeeded");
    const { run, jobs } = await readRun(runId);
    expect(jobs[0]!.output).toEqual({ portions: 512 });
    expect(jobs[2]!.output).toEqual({ items: 2 });
    expect(seen!.run).toEqual({
      id: runId,
      outletId: ids.outletA,
      timezone: "Asia/Jakarta",
      businessDate: DATE,
    });
    expect(seen!.outputs).toEqual({
      ingest: { portions: 512 },
      analyze: expect.objectContaining({ spikes: [] }),
    });
    expect(seen!.servers).toBe(mcp.servers);
    expect(seen!.trace.traceId).toBe(run.traceId);
    expect(seen!.signal.aborted).toBe(false);
  });

  it("does not save output that breaks the step's schema, and stops the run", async () => {
    const analyze: StepDefinition = {
      name: "analyze",
      output: z.object({ flagged: z.array(z.string()) }),
      run: async () => ({ flagged: "rendang" }) as never,
    };
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps: { ...DEFAULT_STEPS, analyze } });

    await expectStatus(runId, "failed");
    const { run, jobs } = await readRun(runId);
    expect(run.error).toMatch(/flagged/);
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(jobs[1]).toMatchObject({
      status: "failed",
      output: undefined,
      error: expect.stringMatching(/flagged/),
      finishedAt: expect.any(Date),
    });
    expect(jobs.map((j) => j.status)).toEqual([
      "succeeded",
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("finds the outlet by name, whatever its case", async () => {
    const { runId } = await runs.startManual({ outlet: "warung TEST", date: DATE });
    expect((await readRun(runId)).run.outletId).toBe(ids.outletA);
  });

  it("refuses an unknown outlet, an ambiguous name, and an invalid date", async () => {
    const twins = await db
      .insert(outlets)
      .values([{ name: "Warung Kembar" }, { name: "Warung Kembar" }])
      .returning({ id: outlets.id });
    try {
      const start = (outlet: string, date: string) => runs.startManual({ outlet, date });
      await expect(start("Warung Hilang", DATE)).rejects.toThrow(
        'No outlet with the id or name "Warung Hilang"',
      );
      await expect(start("00000000-0000-4000-8000-0000000000ff", DATE)).rejects.toThrow(
        /No outlet/,
      );
      await expect(start("Warung Kembar", DATE)).rejects.toThrow(/2 outlets.*use the id/);
      await expect(start(ids.outletA, "2026-02-30")).rejects.toThrow(/date.*YYYY-MM-DD/);
      await expect(start(ids.outletA, "1 March")).rejects.toThrow(/date.*YYYY-MM-DD/);
      expect(await db.select().from(agentRuns)).toEqual([]);
    } finally {
      await db.delete(outlets).where(
        inArray(
          outlets.id,
          twins.map((t) => t.id),
        ),
      );
    }
  });

  it("refuses while a run for that outlet and date is in progress, then allows a repeat", async () => {
    const first = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await expect(runs.startManual({ outlet: ids.outletA, date: DATE })).rejects.toThrow(
      `Run ${first.runId} for this outlet and date is already in progress`,
    );
    // Another date or outlet is free.
    await runs.startManual({ outlet: ids.outletA, date: "2026-03-02" });
    await runs.startManual({ outlet: ids.outletB, date: DATE });

    startWorker();
    await expectStatus(first.runId, "succeeded");
    const second = await runs.startManual({ outlet: ids.outletA, date: DATE });
    expect(second.runId).not.toBe(first.runId);
    await expectStatus(second.runId, "succeeded");
  });

  it("starts one run when the command is given twice at the same moment", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => runs.startManual({ outlet: ids.outletA, date: DATE })),
    );
    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
    expect(await db.select().from(pipelineJobs)).toHaveLength(5);
    // The losers are refused, or handed the same run if its jobs were not queued yet.
    for (const r of results) {
      if (r.status === "fulfilled") expect(r.value.runId).toBe(rows[0]!.id);
      else expect(String(r.reason)).toMatch(/already in progress/);
    }
    const ingest = countingStep("ingest");
    startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
    await expectStatus(rows[0]!.id, "succeeded");
    expect(ingest.started.count).toBe(1);
  });

  it("completes a run whose jobs never reached Redis when the command is repeated", async () => {
    const first = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await redis.clear(); // as if the process died between Postgres and Redis

    const again = await runs.startManual({ outlet: ids.outletA, date: DATE });
    expect(again.runId).toBe(first.runId);
    expect(await db.select().from(pipelineJobs)).toHaveLength(5);
    startWorker();
    await expectStatus(first.runId, "succeeded");
  });

  it("does not run a step again that already has its result", async () => {
    const ingest = countingStep("ingest");
    const analyze = blockingStep("analyze");
    const steps = { ...DEFAULT_STEPS, ingest: ingest.step, analyze: analyze.step };
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps });
    await expect.poll(() => analyze.started.count).toBe(1);

    // Redis loses the run's jobs while Postgres keeps Ingest's result.
    await Promise.all(workers.splice(0).map((w) => w.stop(0)));
    await redis.clear();
    await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps });
    await expect.poll(() => analyze.started.count).toBe(2);
    analyze.release();

    await expectStatus(runId, "succeeded");
    expect(ingest.started.count).toBe(1);
    const { jobs } = await readRun(runId);
    expect(jobs.map((j) => [j.step, j.status, j.attempts]).slice(0, 2)).toEqual([
      ["ingest", "succeeded", 1],
      ["analyze", "succeeded", 2],
    ]);
  });

  it("waits for the current step when stopped", async () => {
    const ingest = blockingStep("ingest");
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
    await expect.poll(() => ingest.started.count).toBe(1);

    const stopped = workers.splice(0)[0]!.stop(10_000);
    ingest.release();
    await stopped;
    expect((await readRun(runId)).jobs.map((j) => j.status).slice(0, 2)).toEqual([
      "succeeded",
      "pending",
    ]);
  });

  it("stops after the time allowed even if the current step has not finished", async () => {
    const ingest = blockingStep("ingest");
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
    await expect.poll(() => ingest.started.count).toBe(1);

    const before = Date.now();
    await workers.splice(0)[0]!.stop(200);
    expect(Date.now() - before).toBeLessThan(2_000);
    expect((await readRun(runId)).jobs[0]!.status).toBe("running");
  });

  it("marks a run dead whose failure was never recorded, and starts a new one", async () => {
    const dead = await runs.startManual({ outlet: ids.outletA, date: DATE });
    // Postgres is unreachable for the worker, so it can record nothing.
    const broken = createDb(testDbUrl);
    await broken.pool.end();
    const failures: string[] = [];
    startWorker({ db: broken.db, log: (message) => failures.push(message) });
    await expect.poll(() => failures.join()).toMatch(/Could not record/);
    await workers.splice(0)[0]!.stop();
    expect((await readRun(dead.runId)).run.status).toBe("running");

    const next = await runs.startManual({ outlet: ids.outletA, date: DATE });
    expect(next.runId).not.toBe(dead.runId);
    const { run, jobs } = await readRun(dead.runId);
    expect(run).toMatchObject({ status: "failed", finishedAt: expect.any(Date) });
    expect(run.error).toMatch(/^ingest: /);
    expect(jobs.map((j) => j.status)).toEqual([
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    startWorker();
    await expectStatus(next.runId, "succeeded");
  });

  it("records a failure that happens before the step starts", async () => {
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await db.update(agentRuns).set({ traceId: null }).where(eq(agentRuns.id, runId));
    startWorker();
    await expectStatus(runId, "failed");
    const { jobs } = await readRun(runId);
    expect(jobs[0]).toMatchObject({ status: "failed", error: expect.any(String) });
  });

  it("keeps the first result when a worker thought dead finishes or fails late", async () => {
    for (const late of ["finishes", "fails"] as const) {
      let settleLate = () => {};
      let started = 0;
      const ingest: StepDefinition = {
        name: "ingest",
        output: z.object({ from: z.string() }),
        run: async () => {
          if (++started > 1) return { from: "second worker" };
          await new Promise<void>((resolve) => (settleLate = resolve));
          if (late === "fails") throw new Error("late failure");
          return { from: "first worker" };
        },
      };
      const steps = { ...DEFAULT_STEPS, ingest };
      const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
      startWorker({ steps });
      await expect.poll(() => started).toBe(1);
      await workers.splice(0)[0]!.stop(0);
      await redis.clear();
      await runs.startManual({ outlet: ids.outletA, date: DATE });
      startWorker({ steps });
      await expectStatus(runId, "succeeded");

      settleLate();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { run, jobs } = await readRun(runId);
      expect(run).toMatchObject({ status: "succeeded", error: null });
      expect(jobs[0]).toMatchObject({
        status: "succeeded",
        error: null,
        output: { from: "second worker" },
      });
      await Promise.all(workers.splice(0).map((w) => w.stop()));
      await redis.clear();
    }
  });

  it.each(["ingest", "report"] as const)(
    "keeps a recorded failure when a worker thought dead finishes %s late",
    async (name) => {
      const late = blockingStep(name);
      const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
      startWorker({ steps: { ...DEFAULT_STEPS, [name]: late.step } });
      await expect.poll(() => late.started.count).toBe(1);
      await workers.splice(0)[0]!.stop(0);

      // Its jobs are queued again, fail without a record, and the run is replaced.
      await redis.clear();
      await runs.startManual({ outlet: ids.outletA, date: DATE });
      const broken = createDb(testDbUrl);
      await broken.pool.end();
      const failures: string[] = [];
      startWorker({ db: broken.db, log: (message) => failures.push(message) });
      await expect.poll(() => failures.join()).toMatch(/Could not record/);
      await workers.splice(0)[0]!.stop();
      const next = await runs.startManual({ outlet: ids.outletA, date: DATE });
      expect((await readRun(runId)).run.status).toBe("failed");

      late.release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { run, jobs } = await readRun(runId);
      expect(run).toMatchObject({ status: "failed", error: expect.any(String) });
      if (name === "ingest") expect(jobs[0]).toMatchObject({ status: "failed", output: undefined });
      startWorker();
      await expectStatus(next.runId, "succeeded");
    },
  );

  it("fails the step whose output would not survive being saved as JSON", async () => {
    const ingest: StepDefinition = {
      name: "ingest",
      output: z.object({ day: z.date() }),
      run: async () => ({ day: new Date() }),
    };
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    startWorker({ steps: { ...DEFAULT_STEPS, ingest } });
    await expectStatus(runId, "failed");
    expect((await readRun(runId)).jobs.map((j) => j.status).slice(0, 2)).toEqual([
      "failed",
      "pending",
    ]);
  });
});
