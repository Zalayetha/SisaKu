import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { prepLogs, sales, wasteEntries } from "@sisaku/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  type AnalyzeOutput,
  createPipelineRuns,
  createPipelineWorker,
  DEFAULT_STEPS,
  SPIKE_WINDOW_DAYS,
} from "./index";
import { expectStatus, readRun } from "./testing/runs";
import { testRedis, testRedisUrl } from "./testing/redis";

// The Analyze step, observed through whole pipeline runs. Each case writes its own days in a month
// of its own, so cases do not see each other's sales or waste. Rendang is 0.120 kg a portion at
// Rp 13,000; nasi is 0.200 kg at Rp 2,500.

describe.skipIf(!testDbUrl || !testRedisUrl)("Analyze step", () => {
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

  /** Runs the pipeline and returns the run's status and its Analyze job. */
  async function analyze(outlet: string, date: string) {
    const { runId } = await runs.startManual({ outlet, date });
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      steps: DEFAULT_STEPS,
      redis: redis.redis,
      log: () => undefined,
    });
    try {
      await expectStatus(db, runId, "succeeded");
      const job = (await readRun(db, runId)).job("analyze");
      return { status: job.status, output: job.output as AnalyzeOutput };
    } finally {
      await worker.stop();
    }
  }

  /** The day `offset` days after `date` (YYYY-MM-DD). */
  function day(date: string, offset: number) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  /** A sales record of `qtySold` portions for each item on each of the days. */
  async function sell(
    outlet: string,
    items: readonly string[],
    days: readonly string[],
    qtySold = 20,
  ) {
    await db
      .insert(sales)
      .values(
        days.flatMap((date) =>
          items.map((itemId) => ({ outletId: outlet, itemId, date, qtySold })),
        ),
      );
  }

  /** One waste entry for the item on each of the days, at noon in Jakarta. */
  async function waste(
    outlet: string,
    itemId: string,
    kg: number,
    days: readonly string[],
    cause: "over_prep" | "spoilage" = "over_prep",
  ) {
    await db.insert(wasteEntries).values(
      days.map((date) => ({
        outletId: outlet,
        itemId,
        loggedAt: new Date(`${date}T12:00:00+07:00`),
        weightKg: kg.toFixed(3),
        cause,
        source: "text" as const,
      })),
    );
  }

  /** The days before `date` that an item's average looks at. */
  const window = (date: string) =>
    Array.from({ length: SPIKE_WINDOW_DAYS }, (_, i) => day(date, i - SPIKE_WINDOW_DAYS));

  it("flags rendang on a holiday where its sales drop and its prep does not", async () => {
    // 30 portions of rendang prepped every day. 25 sell on a normal day, leaving 5 (0.6 kg); 10
    // sell on the holiday, leaving 20 (2.4 kg).
    const date = "2026-06-15";
    await db.insert(prepLogs).values(
      [...window(date), date].map((d) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date: d,
        qtyPrepped: 30,
      })),
    );
    await sell(ids.outletA, [ids.rendang], window(date), 25);
    await sell(ids.outletA, [ids.rendang], [date], 10);
    await waste(ids.outletA, ids.rendang, 0.6, window(date));
    await waste(ids.outletA, ids.rendang, 2.4, [date]);
    const { status, output } = await analyze(ids.outletA, date);
    expect(status).toBe("succeeded");
    expect(output.spikes).toEqual([
      {
        item_id: ids.rendang,
        item_name: "Rendang Sapi",
        waste_kg: 2.4,
        average_kg: 0.6,
        days_counted: 14,
        investigated: false,
        explanation: { kind: "unexplained" },
      },
    ]);
  });

  it("flags nothing at exactly double the average, nor over double but under 1 kg", async () => {
    // 14 days of 0.6 kg add up to 8.4 kg, but 8.399999999999999 in floating point.
    const date = "2026-07-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 0.6, window(date));
    await waste(ids.outletA, ids.rendang, 1.2, [date]);
    await waste(ids.outletA, ids.nasi, 0.2, window(date));
    await waste(ids.outletA, ids.nasi, 0.9, [date]);
    const { status, output } = await analyze(ids.outletA, date);
    expect(status).toBe("succeeded");
    expect(output.waste_by_item).toHaveLength(2);
    expect(output.spikes).toEqual([]);
  });

  it("flags an item with no waste in the window once it reaches 1 kg", async () => {
    const date = "2026-08-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.nasi, 1, [date]);
    const { output } = await analyze(ids.outletA, date);
    expect(output.spikes).toMatchObject([
      { item_id: ids.nasi, waste_kg: 1, average_kg: 0, days_counted: 14 },
    ]);
  });

  it("counts only days with a sales record toward the average", async () => {
    // Closed on 4 of the 14 days. Over all 14 the average would be 0.5 and 1.1 kg a spike; over
    // the 10 open days it is 0.7, and 1.1 kg is not.
    const date = "2026-09-15";
    const open = window(date).slice(4);
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...open, date]);
    await waste(ids.outletA, ids.rendang, 0.7, open);
    await waste(ids.outletA, ids.rendang, 1.1, [date]);
    // Waste logged on a closed day is left out too, or the average would be 0.79.
    await waste(ids.outletA, ids.rendang, 0.9, [window(date)[0]!]);
    expect((await analyze(ids.outletA, date)).output.spikes).toEqual([]);
    // 1.5 kg is.
    await waste(ids.outletA, ids.rendang, 0.4, [date]);
    expect((await analyze(ids.outletA, date)).output.spikes).toMatchObject([
      { item_id: ids.rendang, waste_kg: 1.5, average_kg: 0.7, days_counted: 10 },
    ]);
  });

  it("flags nothing with fewer than 7 days with a sales record", async () => {
    const date = "2026-10-15";
    const open = window(date).slice(8); // 6 days
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...open, date]);
    await waste(ids.outletA, ids.rendang, 5, [date]);
    const { status, output } = await analyze(ids.outletA, date);
    expect(status).toBe("succeeded");
    expect(output.waste_by_item).toMatchObject([{ item_id: ids.rendang, waste_kg: 5 }]);
    expect(output.spikes).toEqual([]);
  });

  it("counts only the days the item itself was sold, as for an item new to the menu", async () => {
    // The outlet is open all 14 days; rendang joined the menu 8 days ago and wastes 0.8 kg a day.
    // Over the outlet's 14 days its average would be 0.457 and 1.2 kg a spike; over its own 8 it
    // is 0.8, and 1.2 kg is not.
    const date = "2027-03-15";
    const onMenu = window(date).slice(6);
    await sell(ids.outletA, [ids.nasi], [...window(date), date]);
    await sell(ids.outletA, [ids.rendang], [...onMenu, date]);
    await waste(ids.outletA, ids.rendang, 0.8, onMenu);
    await waste(ids.outletA, ids.rendang, 1.2, [date]);
    expect((await analyze(ids.outletA, date)).output.spikes).toEqual([]);
    // 1.7 kg is.
    await waste(ids.outletA, ids.rendang, 0.5, [date]);
    expect((await analyze(ids.outletA, date)).output.spikes).toMatchObject([
      { item_id: ids.rendang, waste_kg: 1.7, average_kg: 0.8, days_counted: 8 },
    ]);
  });

  it("flags nothing for an item sold on fewer than 7 days, though the outlet sold on more", async () => {
    const date = "2027-04-15";
    const onMenu = window(date).slice(8); // 6 days
    await sell(ids.outletA, [ids.nasi], [...window(date), date]);
    await sell(ids.outletA, [ids.rendang], [...onMenu, date]);
    await waste(ids.outletA, ids.rendang, 5, [date]);
    expect((await analyze(ids.outletA, date)).output.spikes).toEqual([]);
  });

  it("saves empty lists when no waste was logged on the day", async () => {
    const date = "2026-11-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 0.6, window(date));
    const { status, output } = await analyze(ids.outletA, date);
    expect(status).toBe("succeeded");
    expect(output).toEqual({ waste_by_item: [], waste_by_cause: [], spikes: [] });
  });

  it("totals the day's waste by item and by cause as query_waste does", async () => {
    const date = "2026-12-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 1.2, [date]); // 10 portions
    await waste(ids.outletA, ids.rendang, 0.36, [date], "spoilage"); // 3 portions
    await waste(ids.outletA, ids.nasi, 0.4, [date], "spoilage"); // 2 portions
    const { output } = await analyze(ids.outletA, date);
    expect(output.waste_by_item).toEqual(
      expect.arrayContaining([
        {
          item_id: ids.rendang,
          item_name: "Rendang Sapi",
          waste_kg: 1.56,
          portions: 13,
          cost_idr: 169_000,
        },
        {
          item_id: ids.nasi,
          item_name: expect.any(String),
          waste_kg: 0.4,
          portions: 2,
          cost_idr: 5_000,
        },
      ]),
    );
    expect(output.waste_by_cause).toEqual(
      expect.arrayContaining([
        { cause: "over_prep", waste_kg: 1.2, portions: 10, cost_idr: 130_000 },
        { cause: "spoilage", waste_kg: 0.76, portions: 5, cost_idr: 44_000 },
      ]),
    );
    expect(output.waste_by_item).toHaveLength(2);
    expect(output.waste_by_cause).toHaveLength(2);
  });

  it("never reads another outlet's waste or sales", async () => {
    // Outlet B has a big day of soto; outlet A has nothing on it.
    const date = "2027-01-15";
    await sell(ids.outletB, [ids.soto], [...window(date), date]);
    await waste(ids.outletB, ids.soto, 3, [date]);
    await waste(ids.outletA, ids.rendang, 3, [date]); // but no sales for A
    const a = await analyze(ids.outletA, date);
    expect(a.output.waste_by_item.map((i) => i.item_id)).toEqual([ids.rendang]);
    expect(a.output.spikes).toEqual([]); // A has no days with sales
    const b = await analyze(ids.outletB, date);
    expect(b.output.waste_by_item.map((i) => i.item_id)).toEqual([ids.soto]);
    expect(b.output.spikes.map((s) => s.item_id)).toEqual([ids.soto]);
  });

  it("orders spikes by kg, largest first", async () => {
    const date = "2027-02-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 1.2, [date]);
    await waste(ids.outletA, ids.nasi, 2, [date]);
    const { output } = await analyze(ids.outletA, date);
    expect(output.spikes.map((s) => s.item_id)).toEqual([ids.nasi, ids.rendang]);
  });
});
