import type { McpServer } from "@anvia/core/mcp";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { forecasts, outlets, prepLogs, sales } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { createPipelineRuns, createPipelineWorker, type ForecastOutput } from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";
import { readRun } from "./testing/runs";
import { TEST_STEPS } from "./testing/steps";

// The Forecast step, observed through whole pipeline runs. Each case writes its own days in a
// separate month so cases do not see each other's sales or prep logs.

describe.skipIf(!testDbUrl || !testRedisUrl)("Forecast step", () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 20 });
  });

  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  async function runForecast(
    outlet: string,
    date: string,
    {
      servers = mcp.servers,
      beforeWorker,
    }: {
      servers?: readonly McpServer[];
      beforeWorker?: (runId: string) => Promise<void>;
    } = {},
  ) {
    const { runId } = await runs.startManual({ outlet, date });
    if (beforeWorker) await beforeWorker(runId);
    const worker = createPipelineWorker({
      db,
      servers,
      steps: TEST_STEPS,
      redis: redis.redis,
      log: () => undefined,
    });
    try {
      await expect
        .poll(async () => (await readRun(db, runId)).run.status, { timeout: 10_000 })
        .not.toBe("running");
      const { run, jobs, job: jobOf, statuses } = await readRun(db, runId);
      expect(run.status, jobs.map((j) => j.error).join("; ")).toBe("succeeded");
      const job = jobOf("forecast");
      const rows = await db.select().from(forecasts).where(eq(forecasts.runId, runId));
      return {
        runId,
        status: job.status,
        attempts: job.attempts,
        error: job.error,
        statuses,
        output: job.output as ForecastOutput,
        rows,
      };
    } finally {
      await worker.stop();
    }
  }

  /** Wraps MCP servers to record which tool names were called. */
  function recordingTools() {
    const called: string[] = [];
    const servers: McpServer[] = mcp.servers.map((server) => ({
      ...server,
      tools: server.tools.map((tool) => ({
        ...tool,
        call: async (args, context) => {
          called.push(tool.mcp.remoteName);
          return tool.call(args, context);
        },
      })),
    }));
    return { servers, called };
  }

  it("computes the 4-weekday sales average rounded to 1 decimal place and stores summary metadata without duplicating quantities", async () => {
    // Business date is Sunday 2026-05-31 -> forecasts Monday 2026-06-01.
    // The 4 matching Mondays are 2026-05-04, 2026-05-11, 2026-05-18, 2026-05-25.
    await db.insert(sales).values([
      // Nasi: (100 + 102 + 105 + 100) / 4 = 101.75 -> 101.8
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-05-04", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-05-11", qtySold: 102 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-05-18", qtySold: 105 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-05-25", qtySold: 100 },
      // Rendang: (40 + 41 + 42 + 40) / 4 = 40.75 -> 40.8
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-05-04", qtySold: 40 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-05-11", qtySold: 41 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-05-18", qtySold: 42 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-05-25", qtySold: 40 },
      // Non-matching weekday (Tuesday) should be ignored.
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-05-26", qtySold: 999 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-05-26", qtySold: 999 },
    ]);

    const { status, attempts, output, rows } = await runForecast(ids.outletA, "2026-05-31");

    expect(status).toBe("succeeded");
    expect(attempts).toBe(1);
    expect(output).toEqual({
      target_date: "2026-06-01",
      weather: null,
      calendar_events: [],
      llm_called: false,
      adjusted_count: 0,
      items: expect.arrayContaining([
        {
          forecast_id: expect.any(String),
          item_id: ids.nasi,
          low_confidence: false,
          history_days: 4,
        },
        {
          forecast_id: expect.any(String),
          item_id: ids.rendang,
          low_confidence: false,
          history_days: 4,
        },
      ]),
    });
    expect(output.items).toHaveLength(2);
    for (const item of output.items) {
      expect(Object.keys(item).sort()).toEqual([
        "forecast_id",
        "history_days",
        "item_id",
        "low_confidence",
      ]);
    }

    const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
    const outByItem = new Map(output.items.map((i) => [i.item_id, i]));
    expect(rows).toHaveLength(2);
    expect(rowByItem.get(ids.nasi)).toMatchObject({
      id: outByItem.get(ids.nasi)!.forecast_id,
      outletId: ids.outletA,
      itemId: ids.nasi,
      date: "2026-06-01",
      baselineQty: 101.8,
      adjustedQty: 101.8,
      reason: null,
      model: "baseline",
    });
    expect(rowByItem.get(ids.rendang)).toMatchObject({
      id: outByItem.get(ids.rendang)!.forecast_id,
      outletId: ids.outletA,
      itemId: ids.rendang,
      date: "2026-06-01",
      baselineQty: 40.8,
      adjustedQty: 40.8,
      reason: null,
      model: "baseline",
    });
  });

  it("averages only the available matching weekdays when 2 or 3 are present, with low_confidence false", async () => {
    // Business date 2026-07-04 (Saturday) -> forecasts Sunday 2026-07-05.
    // Matching Sundays: 2026-06-07, 2026-06-14, 2026-06-21, 2026-06-28.
    await db.insert(sales).values([
      // Nasi has 3 matching Sundays: (80 + 82 + 85) / 3 = 82.333... -> 82.3
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-06-07", qtySold: 80 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-06-21", qtySold: 82 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-06-28", qtySold: 85 },
      // Rendang has 2 matching Sundays: (30 + 35) / 2 = 32.5
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-06-14", qtySold: 30 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-06-28", qtySold: 35 },
    ]);

    const { output, rows } = await runForecast(ids.outletA, "2026-07-04");

    const outByItem = new Map(output.items.map((i) => [i.item_id, i]));
    const rowByItem = new Map(rows.map((r) => [r.itemId, r]));

    expect(outByItem.get(ids.nasi)).toMatchObject({ low_confidence: false, history_days: 3 });
    expect(outByItem.get(ids.rendang)).toMatchObject({ low_confidence: false, history_days: 2 });
    expect(rowByItem.get(ids.nasi)?.baselineQty).toBe(82.3);
    expect(rowByItem.get(ids.rendang)?.baselineQty).toBe(32.5);
  });

  it("falls back to the 14-day prep_logs average (or 0 if none) with low_confidence true when fewer than 2 matching weekdays exist", async () => {
    // Business date 2026-08-20 (Thursday) -> forecasts Friday 2026-08-21.
    // 14-day prep window: 2026-08-07 through 2026-08-20 inclusive.
    await db.insert(sales).values([
      // Nasi has only 1 matching Friday (2026-08-14) -> triggers prep fallback.
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-08-14", qtySold: 90 },
      // Rendang has 0 matching Fridays and no prep logs -> baseline 0.
    ]);
    await db.insert(prepLogs).values([
      // Inside 14-day window: (110 + 115 + 116) / 3 = 113.666... -> 113.7
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-08-07", qtyPrepped: 110 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-08-15", qtyPrepped: 115 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-08-20", qtyPrepped: 116 },
      // Outside 14-day window (2026-08-06 = business_date - 14): must be ignored.
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-08-06", qtyPrepped: 999 },
    ]);

    const { output, rows } = await runForecast(ids.outletA, "2026-08-20");

    const outByItem = new Map(output.items.map((i) => [i.item_id, i]));
    const rowByItem = new Map(rows.map((r) => [r.itemId, r]));

    expect(outByItem.get(ids.nasi)).toMatchObject({ low_confidence: true, history_days: 1 });
    expect(outByItem.get(ids.rendang)).toMatchObject({ low_confidence: true, history_days: 0 });
    expect(rowByItem.get(ids.nasi)).toMatchObject({
      baselineQty: 113.7,
      adjustedQty: 113.7,
      reason: null,
      model: "baseline",
    });
    expect(rowByItem.get(ids.rendang)).toMatchObject({
      baselineQty: 0,
      adjustedQty: 0,
      reason: null,
      model: "baseline",
    });
  });

  it("skips sales and prep lookups and writes zero rows when the outlet has an empty menu", async () => {
    const emptyOutlet = "00000000-0000-4000-8000-00000000000e";
    await db
      .insert(outlets)
      .values({ id: emptyOutlet, name: "Empty Menu Outlet", timezone: "Asia/Jakarta" });

    const { servers, called } = recordingTools();
    const { status, output, rows } = await runForecast(emptyOutlet, "2026-09-10", { servers });

    expect(status).toBe("succeeded");
    expect(output).toEqual({
      target_date: "2026-09-11",
      weather: null,
      calendar_events: [],
      llm_called: false,
      adjusted_count: 0,
      items: [],
    });
    expect(rows).toHaveLength(0);
    // Only ingest calls get_sales/get_prep_log once each; forecast makes no extra calls beyond get_menu.
    expect(called.filter((name) => name === "get_sales")).toHaveLength(1);
    expect(called.filter((name) => name === "get_prep_log")).toHaveLength(1);
  });

  it("scopes forecasts per outlet and replaces prior rows for the same run without duplicates", async () => {
    // Business date 2026-10-15 -> target 2026-10-16 (Friday).
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-10-02", qtySold: 60 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-10-09", qtySold: 70 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-10-02", qtySold: 20 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-10-09", qtySold: 24 },
      { outletId: ids.outletB, itemId: ids.soto, date: "2026-09-25", qtySold: 25 },
      { outletId: ids.outletB, itemId: ids.soto, date: "2026-10-02", qtySold: 30 },
      { outletId: ids.outletB, itemId: ids.soto, date: "2026-10-09", qtySold: 35 },
    ]);

    const runA = await runForecast(ids.outletA, "2026-10-15");
    expect(runA.rows.map((r) => r.itemId).sort()).toEqual([ids.nasi, ids.rendang].sort());
    expect(runA.rows.every((r) => r.outletId === ids.outletA)).toBe(true);

    const { output, rows } = await runForecast(ids.outletB, "2026-10-15", {
      // Simulate an earlier write for the same runId before Forecast saves.
      beforeWorker: async (runId) => {
        await db.insert(forecasts).values({
          runId,
          outletId: ids.outletB,
          itemId: ids.soto,
          date: "2026-10-16",
          baselineQty: 999,
          adjustedQty: 999,
          reason: "stale",
          model: "baseline",
        });
      },
    });

    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({
      item_id: ids.soto,
      low_confidence: false,
      history_days: 3,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: output.items[0]!.forecast_id,
      outletId: ids.outletB,
      itemId: ids.soto,
      date: "2026-10-16",
      baselineQty: 30,
      adjustedQty: 30,
      reason: null,
      model: "baseline",
    });
  });
});
