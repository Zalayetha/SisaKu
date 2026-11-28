import type { McpServer } from "@anvia/core/mcp";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { menuItems, prepLogs, sales, wasteEntries } from "@sisaku/db";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  type AnalyzeOutput,
  createPipelineRuns,
  createPipelineWorker,
  defaultSteps,
  SPIKE_WINDOW_DAYS,
} from "./index";
import { explain, ScriptedModel } from "./testing/scripted-model";
import { readRun } from "./testing/runs";
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

  /**
   * Runs the pipeline and returns the run's status and its Analyze job. Unless a test scripts
   * one, the model answers every investigation at once with no explanation.
   */
  async function analyze(
    outlet: string,
    date: string,
    {
      model = new ScriptedModel(() => explain("unexplained")),
      servers = mcp.servers,
    }: { model?: ScriptedModel; servers?: readonly McpServer[] } = {},
  ) {
    const { runId } = await runs.startManual({ outlet, date });
    const worker = createPipelineWorker({
      db,
      servers,
      steps: defaultSteps({ model }),
      redis: redis.redis,
      log: () => undefined,
    });
    try {
      await expect
        .poll(async () => (await readRun(db, runId)).run.status, { timeout: 10_000 })
        .not.toBe("running");
      const { run, jobs, job: jobOf, statuses } = await readRun(db, runId);
      expect(run.status, jobs.map((j) => j.error).join("; ")).toBe("succeeded");
      const job = jobOf("analyze");
      return {
        status: job.status,
        attempts: job.attempts,
        error: job.error,
        statuses,
        output: job.output as AnalyzeOutput,
      };
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
    const evidence = "Rendang sold 10 portions against 25 on a normal day, with 30 prepped.";
    const model = ScriptedModel.of([
      { toolCall: { name: "get_sales", input: { from: day(date, -7), to: date } } },
      explain("sales_drop", evidence),
    ]);
    const { status, output } = await analyze(ids.outletA, date, { model });
    expect(status).toBe("succeeded");
    expect(output.spikes).toEqual([
      {
        item_id: ids.rendang,
        item_name: "Rendang Sapi",
        waste_kg: 2.4,
        average_kg: 0.6,
        days_counted: 14,
        investigated: true,
        explanation: { kind: "sales_drop", evidence },
      },
    ]);
    // One investigation, offered the four read tools and nothing else.
    expect(model.runs).toHaveLength(1);
    expect(model.requests[0]!.tools.map((t) => t.name).sort()).toEqual([
      "get_prep_log",
      "get_sales",
      "list_entries",
      "query_waste",
    ]);
    // Its prompt gives the spike's numbers.
    expect(JSON.stringify(model.requests[0]!.chatHistory)).toMatch(/Rendang Sapi.*2\.4.*0\.6.*14/s);
  });

  it("flags nothing at exactly double the average, nor over double but under 1 kg", async () => {
    // 14 days of 0.6 kg add up to 8.4 kg, but 8.399999999999999 in floating point.
    const date = "2026-07-15";
    await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 0.6, window(date));
    await waste(ids.outletA, ids.rendang, 1.2, [date]);
    await waste(ids.outletA, ids.nasi, 0.2, window(date));
    await waste(ids.outletA, ids.nasi, 0.9, [date]);
    const model = ScriptedModel.of([]);
    const { status, output } = await analyze(ids.outletA, date, { model });
    expect(status).toBe("succeeded");
    expect(output.waste_by_item).toHaveLength(2);
    expect(output.spikes).toEqual([]);
    // No spike, no investigation.
    expect(model.requests).toHaveLength(0);
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
    const model = ScriptedModel.of([]);
    const { status, output } = await analyze(ids.outletA, date, { model });
    expect(status).toBe("succeeded");
    expect(output).toEqual({ waste_by_item: [], waste_by_cause: [], spikes: [] });
    expect(model.requests).toHaveLength(0);
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

  /** The servers, with every call of the named tool that reaches kitchen-mcp recorded. */
  function recording(remoteName: string) {
    const calls: unknown[] = [];
    const servers = mcp.servers.map((server) => ({
      ...server,
      tools: server.tools.map((tool) =>
        tool.mcp.remoteName === remoteName
          ? {
              ...tool,
              call: (args: unknown, context?: unknown) => {
                calls.push(args);
                return tool.call(args as never, context as never);
              },
            }
          : tool,
      ),
    })) as McpServer[];
    return { servers, calls };
  }

  it("investigates the three largest spikes only, one run each", async () => {
    const date = "2027-05-15";
    const extra = await db
      .insert(menuItems)
      .values(
        ["Soto Ayam", "Gado-Gado", "Tempe Goreng"].map((name) => ({
          outletId: ids.outletA,
          name,
          category: "main",
          costPerPortion: "8000",
          portionWeightKg: "0.25",
          foodCategory: "vegetables",
        })),
      )
      .returning();
    const items = [ids.nasi, ids.rendang, ...extra.map((item) => item.id)];
    try {
      await sell(ids.outletA, items, [...window(date), date]);
      // 5, 4, 3, 2 and 1.5 kg, none in the window before: five spikes.
      for (const [i, item] of items.entries()) {
        await waste(ids.outletA, item, [5, 4, 3, 2, 1.5][i]!, [date]);
      }
      const model = new ScriptedModel(() => explain("over_prep", "Prep was double the usual."));
      const { output } = await analyze(ids.outletA, date, { model });
      expect(output.spikes.map((s) => [s.item_id, s.investigated, s.explanation.kind])).toEqual([
        [items[0], true, "over_prep"],
        [items[1], true, "over_prep"],
        [items[2], true, "over_prep"],
        [items[3], false, "unexplained"],
        [items[4], false, "unexplained"],
      ]);
      expect(model.runs).toHaveLength(3);
    } finally {
      const extraIds = extra.map((item) => item.id);
      await db.delete(wasteEntries).where(inArray(wasteEntries.itemId, extraIds));
      await db.delete(sales).where(inArray(sales.itemId, extraIds));
      await db.delete(menuItems).where(inArray(menuItems.id, extraIds));
    }
  });

  it("refuses an investigation's sixth tool call, and leaves a spike with no answer unexplained", async () => {
    const date = "2027-06-15";
    await sell(ids.outletA, [ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 2, [date]);
    // No step's own reads call list_entries, so every call recorded is the model's.
    const { servers, calls } = recording("list_entries");
    const model = new ScriptedModel(() => ({
      toolCall: { name: "list_entries", input: { from: date, to: date } },
    }));
    const { status, output } = await analyze(ids.outletA, date, { model, servers });
    expect(status).toBe("succeeded");
    expect(calls).toHaveLength(5);
    // The request after the sixth call carries its refusal.
    expect(JSON.stringify(model.requests[6]!.chatHistory.at(-1))).toMatch(/limit of 5 reached/);
    expect(output.spikes).toMatchObject([
      { item_id: ids.rendang, investigated: true, explanation: { kind: "unexplained" } },
    ]);
  });

  it("leaves a spike unexplained when the answer is not a valid explanation", async () => {
    const date = "2027-07-15";
    await sell(ids.outletA, [ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 2, [date]);
    const model = ScriptedModel.of([{ text: '{"kind": "sales_drop"}' }]); // no evidence
    const { output } = await analyze(ids.outletA, date, { model });
    expect(output.spikes).toMatchObject([
      { investigated: true, explanation: { kind: "unexplained" } },
    ]);
  });

  it("gives an investigation the run's outlet, whatever outlet the model asks for", async () => {
    const date = "2027-08-15";
    await sell(ids.outletA, [ids.rendang], [...window(date), date]);
    await waste(ids.outletA, ids.rendang, 2, [date]);
    const { servers, calls } = recording("list_entries");
    const model = ScriptedModel.of([
      {
        toolCall: {
          name: "list_entries",
          input: { outlet_id: ids.outletB, from: date, to: date },
        },
      },
      explain("unexplained"),
    ]);
    await analyze(ids.outletA, date, { model, servers });
    expect(calls).toEqual([{ outlet_id: ids.outletA, from: date, to: date }]);
  });

  describe("when the model fails", () => {
    it("is degraded after four attempts, with every spike unexplained and uninvestigated", async () => {
      const date = "2027-09-15";
      await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
      await waste(ids.outletA, ids.nasi, 2, [date]);
      await waste(ids.outletA, ids.rendang, 1.2, [date]);
      const model = new ScriptedModel(() => ({ error: new Error("model is down") }));
      const { status, attempts, error, statuses, output } = await analyze(ids.outletA, date, {
        model,
      });
      expect(status).toBe("degraded");
      expect(attempts).toBe(4);
      expect(error).toMatch(/model is down/);
      expect(statuses).toEqual(["succeeded", "degraded", "succeeded", "succeeded", "succeeded"]);
      expect(output.waste_by_item.map((i) => i.item_id)).toEqual([ids.nasi, ids.rendang]);
      expect(output.spikes).toMatchObject([
        { item_id: ids.nasi, investigated: false, explanation: { kind: "unexplained" } },
        { item_id: ids.rendang, investigated: false, explanation: { kind: "unexplained" } },
      ]);
      // One request an attempt, each failing the first investigation; none from the fallback.
      expect(model.requests).toHaveLength(4);
    });

    it("retries once after a model error, and saves the explanations from the retry", async () => {
      const date = "2027-10-15";
      await sell(ids.outletA, [ids.rendang], [...window(date), date]);
      await waste(ids.outletA, ids.rendang, 2, [date]);
      const model = ScriptedModel.of([
        { error: new Error("rate limited") },
        explain("spoilage", "All 1 entries were spoilage."),
      ]);
      const { status, attempts, output } = await analyze(ids.outletA, date, { model });
      expect(status).toBe("succeeded");
      expect(attempts).toBe(2);
      expect(output.spikes).toMatchObject([
        { investigated: true, explanation: { kind: "spoilage" } },
      ]);
    });

    it("fails the attempt when a later investigation fails, keeping nothing from it", async () => {
      const date = "2027-11-15";
      await sell(ids.outletA, [ids.nasi, ids.rendang], [...window(date), date]);
      await waste(ids.outletA, ids.nasi, 2, [date]);
      await waste(ids.outletA, ids.rendang, 1.2, [date]);
      // Nasi's investigation answers each time, naming the attempt; rendang's fails the first time.
      let attempt = 0;
      const model = new ScriptedModel((request) => {
        if (!JSON.stringify(request.chatHistory).includes(ids.rendang)) {
          attempt += 1;
          return explain("over_prep", `Attempt ${attempt}.`);
        }
        return attempt === 1
          ? { error: new Error("model is down") }
          : explain("spoilage", `Attempt ${attempt}.`);
      });
      const { status, attempts, output } = await analyze(ids.outletA, date, { model });
      expect(status).toBe("succeeded");
      expect(attempts).toBe(2);
      expect(output.spikes).toMatchObject([
        { item_id: ids.nasi, explanation: { kind: "over_prep", evidence: "Attempt 2." } },
        { item_id: ids.rendang, explanation: { kind: "spoilage", evidence: "Attempt 2." } },
      ]);
    });
  });
});
