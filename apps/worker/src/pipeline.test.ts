import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { agentRuns, outlets, pipelineJobResults, pipelineJobs, PIPELINE_STEPS } from "@sisaku/db";
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
    runs = createPipelineRuns({ db, redis: redis.redis });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
    await redis.clear();
    await db.delete(pipelineJobResults);
    await db.delete(pipelineJobs);
    await db.delete(agentRuns);
  });

  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  async function startWorker(extra: Partial<PipelineWorkerDeps> = {}) {
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

  async function readRun(runId: string) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const rows = await db
      .select()
      .from(pipelineJobs)
      .leftJoin(pipelineJobResults, eq(pipelineJobResults.jobId, pipelineJobs.id))
      .where(eq(pipelineJobs.runId, runId));
    const jobs = PIPELINE_STEPS.flatMap((step) =>
      rows
        .filter((r) => r.pipeline_jobs.step === step)
        .map((r) => ({ ...r.pipeline_jobs, output: r.pipeline_job_results?.output })),
    );
    return { run: run!, jobs };
  }

  async function finished(runId: string) {
    return expect.poll(async () => (await readRun(runId)).run.status, { timeout: 10_000 });
  }

  it("takes a manual run through all five stub steps", async () => {
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await startWorker();

    await (await finished(runId)).toBe("succeeded");
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
      ["ingest", "succeeded", 1, { stub: true }],
      ["analyze", "succeeded", 1, { stub: true }],
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
    await startWorker({ steps: { ...DEFAULT_STEPS, ingest, forecast } });

    await (await finished(runId)).toBe("succeeded");
    const { run, jobs } = await readRun(runId);
    expect(jobs[0]!.output).toEqual({ portions: 512 });
    expect(jobs[2]!.output).toEqual({ items: 2 });
    expect(seen!.run).toEqual({
      id: runId,
      outletId: ids.outletA,
      timezone: "Asia/Jakarta",
      businessDate: DATE,
    });
    expect(seen!.outputs).toEqual({ ingest: { portions: 512 }, analyze: { stub: true } });
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
    await startWorker({ steps: { ...DEFAULT_STEPS, analyze } });

    await (await finished(runId)).toBe("failed");
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

    await startWorker();
    await (await finished(first.runId)).toBe("succeeded");
    const second = await runs.startManual({ outlet: ids.outletA, date: DATE });
    expect(second.runId).not.toBe(first.runId);
    await (await finished(second.runId)).toBe("succeeded");
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
    await startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
    await (await finished(rows[0]!.id)).toBe("succeeded");
    expect(ingest.started.count).toBe(1);
  });

  it("completes a run whose jobs never reached Redis when the command is repeated", async () => {
    const first = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await redis.clear(); // as if the process died between Postgres and Redis

    const again = await runs.startManual({ outlet: ids.outletA, date: DATE });
    expect(again.runId).toBe(first.runId);
    expect(await db.select().from(pipelineJobs)).toHaveLength(5);
    await startWorker();
    await (await finished(first.runId)).toBe("succeeded");
  });

  it("does not run a step again that already has its result", async () => {
    const ingest = countingStep("ingest");
    const analyze = blockingStep("analyze");
    const steps = { ...DEFAULT_STEPS, ingest: ingest.step, analyze: analyze.step };
    const { runId } = await runs.startManual({ outlet: ids.outletA, date: DATE });
    await startWorker({ steps });
    await expect.poll(() => analyze.started.count).toBe(1);

    // Redis loses the run's jobs while Postgres keeps Ingest's result.
    await Promise.all(workers.splice(0).map((w) => w.stop(0)));
    await redis.clear();
    await runs.startManual({ outlet: ids.outletA, date: DATE });
    await startWorker({ steps });
    await expect.poll(() => analyze.started.count).toBe(2);
    analyze.release();

    await (await finished(runId)).toBe("succeeded");
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
    await startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
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
    await startWorker({ steps: { ...DEFAULT_STEPS, ingest: ingest.step } });
    await expect.poll(() => ingest.started.count).toBe(1);

    const before = Date.now();
    await workers.splice(0)[0]!.stop(200);
    expect(Date.now() - before).toBeLessThan(2_000);
    expect((await readRun(runId)).jobs[0]!.status).toBe("running");
  });
});
