import type { McpServer } from "@anvia/core/mcp";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import {
  agentRuns,
  createDb,
  menuItems,
  outlets,
  pipelineJobResults,
  pipelineJobs,
  prepLogs,
  sales,
  wasteEntries,
} from "@sisaku/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineRuns,
  createPipelineWorker,
  DEFAULT_STEPS,
  type IngestOutput,
  type PipelineSteps,
} from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";

// The Ingest step, observed through whole pipeline runs. Outlet A's fixture has sales on 1 to 3
// March, a prep log on 1 March only, and waste on both sides of local midnight.

describe.skipIf(!testDbUrl || !testRedisUrl)("Ingest step", () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis });
  });
  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  /** Runs the pipeline and returns the run's status and its Ingest job. */
  async function ingest(
    outlet: string,
    date: string,
    {
      servers = mcp.servers,
      steps = DEFAULT_STEPS,
    }: { servers?: readonly McpServer[]; steps?: PipelineSteps } = {},
  ) {
    const { runId } = await runs.startManual({ outlet, date });
    const worker = createPipelineWorker({
      db,
      servers,
      steps,
      redis: redis.redis,
      log: () => undefined,
    });
    try {
      const readRun = async () =>
        (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
      await expect
        .poll(async () => (await readRun()).status, { timeout: 10_000 })
        .not.toBe("running");
      const [job] = await db
        .select()
        .from(pipelineJobs)
        .leftJoin(pipelineJobResults, eq(pipelineJobResults.jobId, pipelineJobs.id))
        .where(and(eq(pipelineJobs.runId, runId), eq(pipelineJobs.step, "ingest")));
      return {
        runStatus: (await readRun()).status,
        status: job!.pipeline_jobs.status,
        error: job!.pipeline_jobs.error,
        output: job!.pipeline_job_results?.output as IngestOutput | undefined,
      };
    } finally {
      await worker.stop();
    }
  }

  it("saves the day's totals", async () => {
    const { runStatus, output } = await ingest(ids.outletA, "2026-03-01");
    expect(runStatus).toBe("succeeded");
    expect(output).toEqual({
      items_on_menu: 2,
      sales: { items: 2, portions: 142 }, // 101 nasi + 41 rendang
      prep: { items: 2, portions: 170 }, // 120 + 50
      waste: { entries: 1, weight_kg: 0.36 }, // 21:00 local; nasi at 01:00 is the next day's
      gaps: [],
    });
  });

  it("puts waste logged after local midnight on the next day, though it is still the same day in UTC", async () => {
    const { output } = await ingest(ids.outletA, "2026-03-02");
    expect(output!.waste).toEqual({ entries: 2, weight_kg: 1.24 }); // 1.000 at 01:00 + 0.240 at 12:00
  });

  it("uses the outlet's own timezone", async () => {
    // 2026-03-01 18:00 UTC is 1 March in London and 2 March in Jakarta.
    const [london] = await db
      .insert(outlets)
      .values({ name: "London", timezone: "Europe/London" })
      .returning();
    const [pie] = await db
      .insert(menuItems)
      .values({
        outletId: london!.id,
        name: "Pie",
        category: "main",
        costPerPortion: "10",
        portionWeightKg: "0.3",
        foodCategory: "beef",
      })
      .returning();
    await db.insert(wasteEntries).values({
      outletId: london!.id,
      itemId: pie!.id,
      loggedAt: new Date("2026-03-01T18:00:00Z"),
      weightKg: "0.300",
      cause: "spoilage",
      source: "text",
    });
    expect((await ingest(london!.id, "2026-03-01")).output!.waste.entries).toBe(1);
    expect((await ingest(london!.id, "2026-03-02")).output!.waste.entries).toBe(0);
  });

  it("counts only the run's outlet", async () => {
    // Outlet B sold 7 soto and binned 0.9 kg on the day.
    const { output } = await ingest(ids.outletB, "2026-03-01");
    expect(output).toMatchObject({
      items_on_menu: 1,
      sales: { items: 1, portions: 7 },
      waste: { entries: 1, weight_kg: 0.9 },
    });
  });

  it("reports an empty day as gaps, and the run goes on", async () => {
    const { runStatus, output } = await ingest(ids.outletA, "2026-04-20");
    expect(runStatus).toBe("succeeded");
    expect(output).toEqual({
      items_on_menu: 2,
      sales: { items: 0, portions: 0 },
      prep: { items: 0, portions: 0 },
      waste: { entries: 0, weight_kg: 0 },
      gaps: [{ type: "no_sales" }, { type: "no_prep_log" }, { type: "no_waste_logged" }],
    });
  });

  it("reports a missing prep log once, not for every item sold", async () => {
    const { output } = await ingest(ids.outletA, "2026-03-03");
    expect(output!.sales.items).toBe(2);
    expect(output!.gaps).toEqual([{ type: "no_prep_log" }, { type: "no_waste_logged" }]);
  });

  it("names each item sold but not prepped", async () => {
    const date = "2026-05-01";
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date, qtySold: 12 },
      { outletId: ids.outletA, itemId: ids.rendang, date, qtySold: 4 },
    ]);
    await db
      .insert(prepLogs)
      .values({ outletId: ids.outletA, itemId: ids.nasi, date, qtyPrepped: 15 });
    const { output } = await ingest(ids.outletA, date);
    expect(output!.gaps).toEqual([
      { type: "no_waste_logged" },
      { type: "sold_not_prepped", item_id: ids.rendang, item_name: "Rendang Sapi" },
    ]);
  });

  it("does not count an item recorded with zero portions, nor call the record missing", async () => {
    const date = "2026-05-02";
    await db.insert(sales).values([
      { outletId: ids.outletA, itemId: ids.nasi, date, qtySold: 0 },
      { outletId: ids.outletA, itemId: ids.rendang, date, qtySold: 3 },
    ]);
    await db.insert(prepLogs).values([
      { outletId: ids.outletA, itemId: ids.nasi, date, qtyPrepped: 0 },
      { outletId: ids.outletA, itemId: ids.rendang, date, qtyPrepped: 0 },
    ]);
    const { output } = await ingest(ids.outletA, date);
    expect(output).toMatchObject({
      sales: { items: 1, portions: 3 },
      prep: { items: 0, portions: 0 },
      gaps: [
        { type: "no_waste_logged" },
        { type: "sold_not_prepped", item_id: ids.rendang, item_name: "Rendang Sapi" },
      ],
    });
  });

  it("fails when a read fails, and saves nothing", async () => {
    const broken = createDb(testDbUrl);
    await broken.pool.end();
    const servers = await connectInMemoryServers(broken.db);
    try {
      const result = await ingest(ids.outletA, "2026-03-01", { servers: servers.servers });
      expect(result).toMatchObject({ runStatus: "failed", status: "failed", output: undefined });
      expect(result.error).toBeTruthy();
    } finally {
      await servers.close();
    }
  });

  it("hands its validated output to Analyze", async () => {
    let seen: unknown;
    const steps: PipelineSteps = {
      ...DEFAULT_STEPS,
      analyze: {
        name: "analyze",
        output: z.object({ ok: z.literal(true) }),
        run: async ({ outputs }) => {
          seen = outputs.ingest;
          return { ok: true };
        },
      },
    };
    const { output } = await ingest(ids.outletA, "2026-03-01", { steps });
    expect(seen).toEqual(output);
    expect((seen as IngestOutput).waste.weight_kg).toBe(0.36);
  });
});
