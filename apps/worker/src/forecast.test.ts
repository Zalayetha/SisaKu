import type { CompletionModel } from "@anvia/core";
import type { McpServer } from "@anvia/core/mcp";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { forecasts, outlets, prepLogs, sales } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineRuns,
  createPipelineWorker,
  defaultSteps,
  type ForecastOutput,
} from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";
import { readRun } from "./testing/runs";
import { ScriptedModel } from "./testing/scripted-model";
import { NO_MODEL } from "./testing/steps";

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
      model = NO_MODEL,
      servers = mcp.servers,
      weatherServer,
      beforeWorker,
    }: {
      model?: CompletionModel;
      servers?: readonly McpServer[];
      weatherServer?: McpServer;
      beforeWorker?: (runId: string) => Promise<void>;
    } = {},
  ) {
    const { runId } = await runs.startManual({ outlet, date });
    if (beforeWorker) await beforeWorker(runId);
    const worker = createPipelineWorker({
      db,
      servers,
      steps: defaultSteps({ model, weatherServer }),
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
      weather: { status: "no_location" },
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

  /** Builds a fake Open-Meteo MCP server that records calls and returns scripted responses. */
  function fakeWeatherServer({
    geocoding,
    weatherForecast,
  }: {
    geocoding: (args: Record<string, unknown>) => Promise<unknown> | unknown;
    weatherForecast: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  }) {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const wrap = (remoteName: string, fn: (args: Record<string, unknown>) => unknown) => ({
      name: `weather_${remoteName}`,
      description: remoteName,
      parameters: {},
      mcp: { serverName: "weather", remoteName },
      call: async (args: unknown) => {
        const record = (args ?? {}) as Record<string, unknown>;
        calls.push({ tool: remoteName, args: record });
        const result = await fn(record);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    });
    const server = {
      name: "weather",
      tools: [wrap("geocoding", geocoding), wrap("weather_forecast", weatherForecast)],
    } as unknown as McpServer;
    return { server, calls };
  }

  it("fetches tomorrow's rain forecast via Open-Meteo and sets the deterministic rain trigger", async () => {
    await db
      .update(outlets)
      .set({ location: "Jakarta Selatan" })
      .where(eq(outlets.id, ids.outletA));
    try {
      // Rain above threshold (precipitation_sum >= 5 mm) -> triggered: true
      const rainy = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.2615, longitude: 106.8106 }] }),
        weatherForecast: () => ({
          daily: {
            time: ["2026-11-02"],
            precipitation_sum: [12.4],
            precipitation_probability_max: [45],
          },
        }),
      });
      const resRain = await runForecast(ids.outletA, "2026-11-01", { weatherServer: rainy.server });
      expect(resRain.output.weather).toEqual({
        status: "ok",
        precipitation_mm: 12.4,
        rain_probability_pct: 45,
        triggered: true,
      });
      expect(rainy.calls).toEqual([
        { tool: "geocoding", args: { name: "Jakarta Selatan", count: 1, countryCode: "ID" } },
        {
          tool: "weather_forecast",
          args: {
            latitude: -6.2615,
            longitude: 106.8106,
            daily: ["precipitation_sum", "precipitation_probability_max"],
            timezone: "Asia/Jakarta",
            start_date: "2026-11-02",
            end_date: "2026-11-02",
          },
        },
      ]);

      // Probability above threshold (>= 60%) even with low mm -> triggered: true
      const likelyRain = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.2615, longitude: 106.8106 }] }),
        weatherForecast: () => ({
          daily: {
            time: ["2026-11-03"],
            precipitation_sum: [2.0],
            precipitation_probability_max: [60],
          },
        }),
      });
      const resProb = await runForecast(ids.outletA, "2026-11-02", {
        weatherServer: likelyRain.server,
      });
      expect(resProb.output.weather).toEqual({
        status: "ok",
        precipitation_mm: 2,
        rain_probability_pct: 60,
        triggered: true,
      });

      // Light drizzle below both thresholds -> triggered: false
      const drizzle = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.2615, longitude: 106.8106 }] }),
        weatherForecast: () => ({
          daily: {
            time: ["2026-11-04"],
            precipitation_sum: [4.9],
            precipitation_probability_max: [59],
          },
        }),
      });
      const resDrizzle = await runForecast(ids.outletA, "2026-11-03", {
        weatherServer: drizzle.server,
      });
      expect(resDrizzle.output.weather).toEqual({
        status: "ok",
        precipitation_mm: 4.9,
        rain_probability_pct: 59,
        triggered: false,
      });
    } finally {
      await db.update(outlets).set({ location: null }).where(eq(outlets.id, ids.outletA));
    }
  });

  it("degrades gracefully when weather server is omitted, throws, geocoding fails, or outlet has no location", async () => {
    // 1. Outlet has no location -> status: "no_location"
    const noLocWeather = fakeWeatherServer({
      geocoding: () => {
        throw new Error("should not be called");
      },
      weatherForecast: () => {
        throw new Error("should not be called");
      },
    });
    const resNoLoc = await runForecast(ids.outletA, "2026-11-10", {
      weatherServer: noLocWeather.server,
    });
    expect(resNoLoc.output.weather).toEqual({ status: "no_location" });
    expect(resNoLoc.rows).toHaveLength(2);
    expect(noLocWeather.calls).toHaveLength(0);

    // 2. Weather server omitted -> status: "unavailable"
    await db.update(outlets).set({ location: "Bandung" }).where(eq(outlets.id, ids.outletA));
    try {
      const resOmitted = await runForecast(ids.outletA, "2026-11-11");
      expect(resOmitted.output.weather).toEqual({ status: "unavailable" });
      expect(resOmitted.rows).toHaveLength(2);

      // 3. Weather tool throws -> status: "unavailable", baseline rows still written
      const throwing = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.9175, longitude: 107.6191 }] }),
        weatherForecast: () => {
          throw new Error("Open-Meteo 503");
        },
      });
      const resThrows = await runForecast(ids.outletA, "2026-11-12", {
        weatherServer: throwing.server,
      });
      expect(resThrows.output.weather).toEqual({ status: "unavailable" });
      expect(resThrows.rows).toHaveLength(2);

      // 4. Geocoding fails on known Indonesian city ("Bandung") -> falls back to known city coordinates
      const fallbackCity = fakeWeatherServer({
        geocoding: () => ({ results: [] }),
        weatherForecast: () => ({
          daily: {
            time: ["2026-11-14"],
            precipitation_sum: [8],
            precipitation_probability_max: [70],
          },
        }),
      });
      const resFallback = await runForecast(ids.outletA, "2026-11-13", {
        weatherServer: fallbackCity.server,
      });
      expect(resFallback.output.weather).toEqual({
        status: "ok",
        precipitation_mm: 8,
        rain_probability_pct: 70,
        triggered: true,
      });

      // 5. Address with another city in the street name -> prefers the city at the end (Surabaya)
      await db
        .update(outlets)
        .set({ location: "Jl. Bandung No. 3, Surabaya" })
        .where(eq(outlets.id, ids.outletA));
      const streetCity = fakeWeatherServer({
        geocoding: () => ({ results: [] }),
        weatherForecast: () => ({
          daily: {
            time: ["2026-11-15"],
            precipitation_sum: [6],
            precipitation_probability_max: [65],
          },
        }),
      });
      const resStreetCity = await runForecast(ids.outletA, "2026-11-14", {
        weatherServer: streetCity.server,
      });
      expect(resStreetCity.output.weather).toEqual({
        status: "ok",
        precipitation_mm: 6,
        rain_probability_pct: 65,
        triggered: true,
      });
      expect(streetCity.calls[1]).toMatchObject({
        tool: "weather_forecast",
        args: { latitude: -7.2575, longitude: 112.7521 },
      });

      // 6. Substring city ("Balikpapan" contains "bali") -> must not match Bali; degrades to unavailable
      await db.update(outlets).set({ location: "Balikpapan" }).where(eq(outlets.id, ids.outletA));
      const substringCity = fakeWeatherServer({
        geocoding: () => ({ results: [] }),
        weatherForecast: () => {
          throw new Error("should not be called");
        },
      });
      const resSubstring = await runForecast(ids.outletA, "2026-11-15", {
        weatherServer: substringCity.server,
      });
      expect(resSubstring.output.weather).toEqual({ status: "unavailable" });
      expect(resSubstring.rows).toHaveLength(2);

      // 7. Geocoding fails on unknown location -> status: "unavailable", baseline rows still written
      await db
        .update(outlets)
        .set({ location: "Unknown Village XYZ" })
        .where(eq(outlets.id, ids.outletA));
      const unknownLoc = fakeWeatherServer({
        geocoding: () => ({ results: [] }),
        weatherForecast: () => {
          throw new Error("should not be called");
        },
      });
      const resUnknown = await runForecast(ids.outletA, "2026-11-16", {
        weatherServer: unknownLoc.server,
      });
      expect(resUnknown.output.weather).toEqual({ status: "unavailable" });
      expect(resUnknown.rows).toHaveLength(2);
    } finally {
      await db.update(outlets).set({ location: null }).where(eq(outlets.id, ids.outletA));
    }
  });

  it("makes zero LLM requests on a normal dry day or light drizzle below the rain threshold", async () => {
    // Business date 2027-01-14 (Thursday) -> target 2027-01-15 (Friday, non-holiday).
    // Matching Fridays: 2027-01-08, 2027-01-01.
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date: "2027-01-01", qtySold: 80 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2027-01-08", qtySold: 90 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2027-01-01", qtySold: 30 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2027-01-08", qtySold: 34 },
    ]);
    await db
      .update(outlets)
      .set({ location: "Jakarta Selatan" })
      .where(eq(outlets.id, ids.outletA));
    try {
      const drizzle = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.2615, longitude: 106.8106 }] }),
        weatherForecast: () => ({
          daily: {
            time: ["2027-01-15"],
            precipitation_sum: [4.9],
            precipitation_probability_max: [59],
          },
        }),
      });
      const model = new ScriptedModel(() => {
        throw new Error("LLM should not be called on a dry or drizzle non-holiday");
      });

      const { output, rows } = await runForecast(ids.outletA, "2027-01-14", {
        model,
        weatherServer: drizzle.server,
      });

      expect(model.requests).toHaveLength(0);
      expect(output.calendar_events).toEqual([]);
      expect(output.llm_called).toBe(false);
      expect(output.adjusted_count).toBe(0);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.adjustedQty).toBe(row.baselineQty);
        expect(row.reason).toBeNull();
        expect(row.model).toBe("baseline");
      }
    } finally {
      await db.update(outlets).set({ location: null }).where(eq(outlets.id, ids.outletA));
    }
  });

  it("makes one batch LLM call on a holiday even when weather is unavailable, persisting adjusted and unadjusted items", async () => {
    // Business date 2026-12-24 (Thursday) -> target 2026-12-25 (Friday, Christmas holiday).
    // Matching Fridays: 2026-12-04, 2026-12-11, 2026-12-18.
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-12-04", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-12-11", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-12-18", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-12-04", qtySold: 40 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-12-11", qtySold: 40 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-12-18", qtySold: 40 },
    ]);

    const model = ScriptedModel.of([
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: ids.nasi,
              adjusted_qty: 115.46, // rounds to 115.5
              reason: "Christmas holiday increases family dining demand",
            },
            // Rendang omitted -> stays unadjusted with model = "baseline" and reason = null
          ],
        }),
      },
    ]);

    // Outlet has a location but weatherServer is omitted -> weather: unavailable; calendar still triggers LLM.
    await db
      .update(outlets)
      .set({ location: "Jakarta Selatan" })
      .where(eq(outlets.id, ids.outletA));
    try {
      const { output, rows } = await runForecast(ids.outletA, "2026-12-24", { model });

      expect(model.requests).toHaveLength(1);
      expect(output.weather).toEqual({ status: "unavailable" });
      expect(output.calendar_events).toEqual([{ name: "Christmas", kind: "holiday" }]);
      expect(output.llm_called).toBe(true);
      expect(output.adjusted_count).toBe(1);

      const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
      expect(rowByItem.get(ids.nasi)).toMatchObject({
        baselineQty: 100,
        adjustedQty: 115.5,
        reason: "Christmas holiday increases family dining demand",
        model: "scripted",
      });
      expect(rowByItem.get(ids.rendang)).toMatchObject({
        baselineQty: 40,
        adjustedQty: 40,
        reason: null,
        model: "baseline",
      });
    } finally {
      await db.update(outlets).set({ location: null }).where(eq(outlets.id, ids.outletA));
    }
  });

  it("calls the LLM with weather context when rain triggers on a non-holiday", async () => {
    // Business date 2027-01-21 (Thursday) -> target 2027-01-22 (Friday, non-holiday).
    // Reuses 2027-01-01 and 2027-01-08 sales inserted above (nasi avg 85, rendang avg 32).
    await db
      .update(outlets)
      .set({ location: "Jakarta Selatan" })
      .where(eq(outlets.id, ids.outletA));
    try {
      const heavyRain = fakeWeatherServer({
        geocoding: () => ({ results: [{ latitude: -6.2615, longitude: 106.8106 }] }),
        weatherForecast: () => ({
          daily: {
            time: ["2027-01-22"],
            precipitation_sum: [18.5],
            precipitation_probability_max: [85],
          },
        }),
      });
      const model = ScriptedModel.of([
        {
          text: JSON.stringify({
            adjustments: [
              {
                item_id: ids.nasi,
                adjusted_qty: 75,
                reason: "Heavy rain forecast reduces walk-in lunch traffic",
              },
            ],
          }),
        },
      ]);

      const { output, rows } = await runForecast(ids.outletA, "2027-01-21", {
        model,
        weatherServer: heavyRain.server,
      });

      expect(model.requests).toHaveLength(1);
      const userMessage = JSON.stringify(model.requests[0]!.chatHistory);
      expect(userMessage).toContain("18.5 mm");
      expect(userMessage).toContain("85%");
      expect(output.calendar_events).toEqual([]);
      expect(output.weather).toMatchObject({ status: "ok", triggered: true });
      expect(output.llm_called).toBe(true);
      expect(output.adjusted_count).toBe(1);

      const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
      expect(rowByItem.get(ids.nasi)).toMatchObject({
        baselineQty: 85,
        adjustedQty: 75,
        reason: "Heavy rain forecast reduces walk-in lunch traffic",
        model: "scripted",
      });
      expect(rowByItem.get(ids.rendang)).toMatchObject({
        baselineQty: 32,
        adjustedQty: 32,
        reason: null,
        model: "baseline",
      });
    } finally {
      await db.update(outlets).set({ location: null }).where(eq(outlets.id, ids.outletA));
    }
  });

  it("never adjusts zero-baseline items while allowing low_confidence items with baseline_qty > 0 to be adjusted on Ramadan", async () => {
    // Business date 2026-02-24 (Tuesday) -> target 2026-02-25 (Wednesday, Ramadan 2026).
    // Nasi has 0 sales and 1 prep log (low_confidence: true, baseline 60).
    // Rendang has 0 sales and 0 prep logs (low_confidence: true, baseline 0).
    await db
      .insert(prepLogs)
      .values([{ outletId: ids.outletA, itemId: ids.nasi, date: "2026-02-24", qtyPrepped: 60 }]);

    const model = ScriptedModel.of([
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: ids.nasi,
              adjusted_qty: 48,
              reason: "Ramadan lowers daytime dine-in demand",
            },
          ],
        }),
      },
    ]);

    const { output, rows } = await runForecast(ids.outletA, "2026-02-24", { model });

    expect(model.requests).toHaveLength(1);
    const promptText = JSON.stringify(model.requests[0]!.chatHistory);
    expect(promptText).toContain(ids.nasi);
    expect(promptText).not.toContain(ids.rendang);
    expect(output.calendar_events).toEqual([{ name: "Ramadan 2026", kind: "ramadan" }]);
    expect(output.llm_called).toBe(true);
    expect(output.adjusted_count).toBe(1);

    const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
    expect(rowByItem.get(ids.nasi)).toMatchObject({
      baselineQty: 60,
      adjustedQty: 48,
      reason: "Ramadan lowers daytime dine-in demand",
      model: "scripted",
    });
    expect(rowByItem.get(ids.rendang)).toMatchObject({
      baselineQty: 0,
      adjustedQty: 0,
      reason: null,
      model: "baseline",
    });
  });

  it("retries on invalid LLM output and succeeds cleanly on a later attempt without duplicate forecasts rows", async () => {
    // Business date 2026-04-02 (Thursday) -> target 2026-04-03 (Friday, Good Friday holiday).
    // Matching Fridays: 2026-03-20, 2026-03-27.
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-03-20", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-03-27", qtySold: 100 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-03-20", qtySold: 40 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-03-27", qtySold: 40 },
    ]);

    // Attempts 1-3 return invalid outputs (malformed JSON, negative qty, unknown item_id);
    // attempt 4 succeeds cleanly.
    const model = ScriptedModel.of([
      { text: "{not valid json" },
      {
        text: JSON.stringify({
          adjustments: [{ item_id: ids.nasi, adjusted_qty: -10, reason: "Invalid" }],
        }),
      },
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: "00000000-0000-4000-8000-000000000999",
              adjusted_qty: 50,
              reason: "Unknown item",
            },
          ],
        }),
      },
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: ids.nasi,
              adjusted_qty: 110,
              reason: "Good Friday holiday boosts family meals",
            },
          ],
        }),
      },
    ]);

    const { status, attempts, output, rows } = await runForecast(ids.outletA, "2026-04-02", {
      model,
    });

    expect(status).toBe("succeeded");
    expect(attempts).toBe(4);
    expect(model.requests).toHaveLength(4);
    expect(output.llm_called).toBe(true);
    expect(output.adjusted_count).toBe(1);
    expect(rows).toHaveLength(2);
    const rowByItem = new Map(rows.map((r) => [r.itemId, r]));
    expect(rowByItem.get(ids.nasi)).toMatchObject({
      baselineQty: 100,
      adjustedQty: 110,
      reason: "Good Friday holiday boosts family meals",
      model: "scripted",
    });
    expect(rowByItem.get(ids.rendang)).toMatchObject({
      baselineQty: 40,
      adjustedQty: 40,
      reason: null,
      model: "baseline",
    });

    // Missing reason on attempt 1 fails and retries, succeeding cleanly on attempt 2 without duplicates.
    const retryModel = ScriptedModel.of([
      {
        text: JSON.stringify({
          adjustments: [{ item_id: ids.nasi, adjusted_qty: 112, reason: "   " }],
        }),
      },
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: ids.nasi,
              adjusted_qty: 112,
              reason: "Good Friday holiday increases lunch traffic",
            },
          ],
        }),
      },
    ]);
    const retryRun = await runForecast(ids.outletA, "2026-04-02", { model: retryModel });
    expect(retryRun.status).toBe("succeeded");
    expect(retryRun.attempts).toBe(2);
    expect(retryRun.rows).toHaveLength(2);
  });
});
