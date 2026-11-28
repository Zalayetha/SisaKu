import type { CompletionModel } from "@anvia/core";
import type { McpServer } from "@anvia/core/mcp";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { forecasts, prepLogs, recommendations, sales } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineRuns,
  createPipelineWorker,
  defaultSteps,
  type RecommendOutput,
} from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";
import { readRun } from "./testing/runs";
import { ScriptedModel } from "./testing/scripted-model";
import { NO_MODEL } from "./testing/steps";

// The Recommend step, observed through whole pipeline runs. Each test uses its own calendar month
// so seeded sales and prep logs never collide across cases.

describe.skipIf(!testDbUrl || !testRedisUrl)("Recommend step", () => {
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

  async function runRecommend(
    outlet: string,
    date: string,
    {
      model = NO_MODEL,
      servers = mcp.servers,
      beforeWorker,
      expectedRunStatus = "succeeded",
    }: {
      model?: CompletionModel;
      servers?: readonly McpServer[];
      beforeWorker?: (runId: string) => Promise<void>;
      expectedRunStatus?: "succeeded" | "failed";
    } = {},
  ) {
    const { runId } = await runs.startManual({ outlet, date });
    if (beforeWorker) await beforeWorker(runId);
    const worker = createPipelineWorker({
      db,
      servers,
      redis: redis.redis,
      steps: defaultSteps({ model }),
    });
    try {
      let state = await readRun(db, runId);
      await expect
        .poll(
          async () => {
            state = await readRun(db, runId);
            return state.run.status;
          },
          { timeout: 10_000, interval: 50 },
        )
        .toBe(expectedRunStatus);
      const recRows = await db
        .select()
        .from(recommendations)
        .where(eq(recommendations.runId, runId));
      const forecastRows = await db.select().from(forecasts).where(eq(forecasts.runId, runId));
      return {
        runId,
        state,
        output: state.job("recommend").output as RecommendOutput | undefined,
        recommendations: recRows,
        forecasts: forecastRows,
      };
    } finally {
      await worker.stop();
    }
  }

  it("computes prep_qty, confidence, and not_required vs pending from 4 matching weekdays of usual prep (including exact 30.0% boundary)", async () => {
    // Business date 2026-06-05 (Fri) -> target_date 2026-06-06 (Sat, normal dry day).
    // 4 matching Saturdays: 2026-05-09, 2026-05-16, 2026-05-23, 2026-05-30.
    const saturdays = ["2026-05-09", "2026-05-16", "2026-05-23", "2026-05-30"];
    const weekdays = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"];

    await db.insert(sales).values([
      // Nasi: 130 on all 4 Saturdays -> baseline 130.0 -> prep_qty 130
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtySold: 130,
      })),
      // Rendang: [53, 52, 53, 53] -> mean 52.75 -> forecast 52.8 -> prep_qty 53
      { outletId: ids.outletA, itemId: ids.rendang, date: saturdays[0]!, qtySold: 53 },
      { outletId: ids.outletA, itemId: ids.rendang, date: saturdays[1]!, qtySold: 52 },
      { outletId: ids.outletA, itemId: ids.rendang, date: saturdays[2]!, qtySold: 53 },
      { outletId: ids.outletA, itemId: ids.rendang, date: saturdays[3]!, qtySold: 53 },
    ]);

    await db.insert(prepLogs).values([
      // Matching Saturdays: Nasi usual prep = 100 (+30.0% exact -> not_required), Rendang = 40 (+32.5% -> pending)
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtyPrepped: 100,
      })),
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtyPrepped: 40,
      })),
      // Much lower weekday prep logs to verify matching-weekday comparison ignores Mon-Fri volume.
      ...weekdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtyPrepped: 50,
      })),
    ]);

    const result = await runRecommend(ids.outletA, "2026-06-05");

    expect(result.output).toMatchObject({
      target_date: "2026-06-06",
      total_items: 2,
      pending_approval_count: 1,
    });

    const nasiSummary = result.output!.items.find((i) => i.item_id === ids.nasi);
    const rendangSummary = result.output!.items.find((i) => i.item_id === ids.rendang);
    expect(nasiSummary).toMatchObject({
      usual_prep_qty: 100,
      change_pct: 30,
      requires_approval: false,
      reason: "Based on 4-week weekday average",
    });
    expect(rendangSummary).toMatchObject({
      usual_prep_qty: 40,
      change_pct: 32.5,
      requires_approval: true,
      reason: "Based on 4-week weekday average",
    });

    expect(result.recommendations).toHaveLength(2);
    const nasiRec = result.recommendations.find((r) => r.id === nasiSummary!.recommendation_id);
    const rendangRec = result.recommendations.find(
      (r) => r.id === rendangSummary!.recommendation_id,
    );
    expect(nasiRec).toMatchObject({
      runId: result.runId,
      forecastId: nasiSummary!.forecast_id,
      prepQty: 130,
      confidence: 0.9,
      status: "not_required",
      approvedBy: null,
    });
    expect(rendangRec).toMatchObject({
      runId: result.runId,
      forecastId: rendangSummary!.forecast_id,
      prepQty: 53,
      confidence: 0.9,
      status: "pending",
      approvedBy: null,
    });
  });

  it("falls back to 14-day prep logs and then baseline_qty, and assigns 3-day and 2-day confidence tiers", async () => {
    // Business date 2026-07-10 (Fri) -> target_date 2026-07-11 (Sat, normal dry day).
    // 4 matching Saturdays: 2026-06-13, 2026-06-20, 2026-06-27, 2026-07-04.
    const saturdays = ["2026-06-13", "2026-06-20", "2026-06-27", "2026-07-04"];

    await db.insert(sales).values([
      // Nasi: 3 matching Saturdays -> baseline 60, history_days 3 -> confidence 0.75
      ...saturdays.slice(1).map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtySold: 60,
      })),
      // Rendang: 2 matching Saturdays -> baseline 50, history_days 2 -> confidence 0.65
      ...saturdays.slice(2).map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtySold: 50,
      })),
    ]);

    await db.insert(prepLogs).values([
      // Nasi: only 1 matching Saturday (2026-07-04) + 2 other days in last 14 days (2026-07-08, 2026-07-09)
      // -> falls back to 14-day prep mean = (40 + 35 + 45) / 3 = 40.0 -> 60 vs 40 = +50% -> pending
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-07-04", qtyPrepped: 40 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-07-08", qtyPrepped: 35 },
      { outletId: ids.outletA, itemId: ids.nasi, date: "2026-07-09", qtyPrepped: 45 },
      // Rendang: zero prep logs anywhere -> falls back to baseline_qty = 50 -> 0% -> not_required
    ]);

    const result = await runRecommend(ids.outletA, "2026-07-10");

    expect(result.output).toMatchObject({
      target_date: "2026-07-11",
      total_items: 2,
      pending_approval_count: 1,
    });

    const nasiSummary = result.output!.items.find((i) => i.item_id === ids.nasi)!;
    const rendangSummary = result.output!.items.find((i) => i.item_id === ids.rendang)!;
    expect(nasiSummary).toMatchObject({
      usual_prep_qty: 40,
      change_pct: 50,
      requires_approval: true,
      reason: "Based on 3-week weekday average",
    });
    expect(rendangSummary).toMatchObject({
      usual_prep_qty: 50,
      change_pct: 0,
      requires_approval: false,
      reason: "Based on 2-week weekday average",
    });

    const nasiRec = result.recommendations.find((r) => r.id === nasiSummary.recommendation_id)!;
    const rendangRec = result.recommendations.find(
      (r) => r.id === rendangSummary.recommendation_id,
    )!;
    expect(nasiRec).toMatchObject({ prepQty: 60, confidence: 0.75, status: "pending" });
    expect(rendangRec).toMatchObject({ prepQty: 50, confidence: 0.65, status: "not_required" });
  });

  it("handles zero usual prep edge cases and low-confidence fallback reasons", async () => {
    // Business date 2026-08-10 (Mon) -> target_date 2026-08-11 (Tue, normal dry day).
    // Matching Tuesdays: 2026-07-14, 2026-07-21, 2026-07-28, 2026-08-04.
    await db.insert(sales).values([
      // Nasi: no sales, no prep -> baseline 0, prep 0, usual 0 -> change_pct 0, not_required, confidence 0.4
      // Rendang: 2 matching Tuesdays of sales (20) -> prep 20, confidence 0.65
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-07-28", qtySold: 20 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-08-04", qtySold: 20 },
    ]);

    await db.insert(prepLogs).values([
      // Rendang: 2 matching Tuesdays with 0 prep -> usual_prep_qty = 0 while prep_qty = 20 -> change_pct null, pending
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-07-28", qtyPrepped: 0 },
      { outletId: ids.outletA, itemId: ids.rendang, date: "2026-08-04", qtyPrepped: 0 },
    ]);

    const result = await runRecommend(ids.outletA, "2026-08-10");

    const nasiSummary = result.output!.items.find((i) => i.item_id === ids.nasi)!;
    const rendangSummary = result.output!.items.find((i) => i.item_id === ids.rendang)!;
    expect(nasiSummary).toMatchObject({
      usual_prep_qty: 0,
      change_pct: 0,
      requires_approval: false,
      reason: "No recent sales or prep history (low confidence)",
    });
    expect(rendangSummary).toMatchObject({
      usual_prep_qty: 0,
      change_pct: null,
      requires_approval: true,
      reason: "Based on 2-week weekday average",
    });

    const nasiRec = result.recommendations.find((r) => r.id === nasiSummary.recommendation_id)!;
    const rendangRec = result.recommendations.find(
      (r) => r.id === rendangSummary.recommendation_id,
    )!;
    expect(nasiRec).toMatchObject({ prepQty: 0, confidence: 0.4, status: "not_required" });
    expect(rendangRec).toMatchObject({ prepQty: 20, confidence: 0.65, status: "pending" });
  });

  it("reduces confidence by 0.15 and carries through degraded reason when Forecast degrades", async () => {
    // Business date 2027-04-30 (Fri) -> target_date 2027-05-01 (Labour Day 2027 -> triggers Forecast LLM).
    // Matching Saturdays: 2027-04-03, 2027-04-10, 2027-04-17, 2027-04-24.
    const saturdays = ["2027-04-03", "2027-04-10", "2027-04-17", "2027-04-24"];

    await db.insert(sales).values(
      saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtySold: 50,
      })),
    );
    await db.insert(prepLogs).values([
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtyPrepped: 50,
      })),
      // Rendang: low_confidence (0 sales, 1 prep log in last 14 days -> baseline 20)
      { outletId: ids.outletA, itemId: ids.rendang, date: "2027-04-29", qtyPrepped: 20 },
    ]);

    const failingModel = new ScriptedModel(() => ({ error: new Error("LLM down") }));

    const result = await runRecommend(ids.outletA, "2027-04-30", { model: failingModel });

    expect(result.state.statuses).toEqual([
      "succeeded",
      "succeeded",
      "degraded",
      "succeeded",
      "succeeded",
    ]);

    const nasiSummary = result.output!.items.find((i) => i.item_id === ids.nasi)!;
    const rendangSummary = result.output!.items.find((i) => i.item_id === ids.rendang)!;
    expect(nasiSummary.reason).toBe("AI adjustment unavailable today");
    expect(rendangSummary.reason).toBe("AI adjustment unavailable today");

    const nasiRec = result.recommendations.find((r) => r.id === nasiSummary.recommendation_id)!;
    const rendangRec = result.recommendations.find(
      (r) => r.id === rendangSummary.recommendation_id,
    )!;
    // 0.9 - 0.15 = 0.75; 0.4 - 0.15 = 0.25
    expect(nasiRec).toMatchObject({ prepQty: 50, confidence: 0.75, status: "not_required" });
    expect(rendangRec).toMatchObject({ prepQty: 20, confidence: 0.25, status: "not_required" });
  });

  it("carries through Forecast LLM reason and flags negative >30% drops for approval", async () => {
    // Business date 2027-08-16 (Mon) -> target_date 2027-08-17 (Independence Day 2027 -> triggers Forecast LLM).
    // Matching Tuesdays: 2027-07-20, 2027-07-27, 2027-08-03, 2027-08-10.
    const tuesdays = ["2027-07-20", "2027-07-27", "2027-08-03", "2027-08-10"];

    await db.insert(sales).values([
      ...tuesdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtySold: 100,
      })),
      ...tuesdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtySold: 40,
      })),
    ]);
    await db.insert(prepLogs).values([
      ...tuesdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtyPrepped: 100,
      })),
      ...tuesdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtyPrepped: 40,
      })),
    ]);

    const model = ScriptedModel.of([
      {
        text: JSON.stringify({
          adjustments: [
            {
              item_id: ids.nasi,
              adjusted_qty: 65,
              reason: "Independence Day reduces office lunch traffic",
            },
          ],
        }),
      },
    ]);

    const result = await runRecommend(ids.outletA, "2027-08-16", { model });

    const nasiSummary = result.output!.items.find((i) => i.item_id === ids.nasi)!;
    expect(nasiSummary).toMatchObject({
      usual_prep_qty: 100,
      change_pct: -35,
      requires_approval: true,
      reason: "Independence Day reduces office lunch traffic",
    });
    const nasiRec = result.recommendations.find((r) => r.id === nasiSummary.recommendation_id)!;
    expect(nasiRec).toMatchObject({ prepQty: 65, confidence: 0.9, status: "pending" });
  });

  it("atomically replaces prior recommendations on a later attempt and fails cleanly when kitchen-mcp errors", async () => {
    // Business date 2027-10-08 (Fri) -> target_date 2027-10-09 (Sat, normal dry day).
    // Matching Saturdays: 2027-09-11, 2027-09-18, 2027-09-25, 2027-10-02.
    const saturdays = ["2027-09-11", "2027-09-18", "2027-09-25", "2027-10-02"];
    await db.insert(sales).values([
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtySold: 80,
      })),
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtySold: 30,
      })),
    ]);
    await db.insert(prepLogs).values([
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.nasi,
        date,
        qtyPrepped: 80,
      })),
      ...saturdays.map((date) => ({
        outletId: ids.outletA,
        itemId: ids.rendang,
        date,
        qtyPrepped: 30,
      })),
    ]);

    function wrapPrepLog(onCall: (callNumber: number) => Promise<void>): McpServer[] {
      let calls = 0;
      return mcp.servers.map((server) => ({
        ...server,
        tools: server.tools.map((tool) =>
          tool.mcp.remoteName === "get_prep_log"
            ? {
                ...tool,
                call: async (args, context) => {
                  calls += 1;
                  await onCall(calls);
                  return tool.call(args, context);
                },
              }
            : tool,
        ),
      }));
    }

    // Case 1: get_prep_log fails on Recommend's first call (after Ingest's 1 call),
    // and we plant a stale recommendation row before attempt 2 succeeds.
    let plantedStale = false;
    let activeRunId = "";
    const flakyServers = wrapPrepLog(async (callNumber) => {
      if (callNumber === 2) {
        if (!plantedStale && activeRunId) {
          plantedStale = true;
          const [existingForecast] = await db
            .select()
            .from(forecasts)
            .where(eq(forecasts.runId, activeRunId));
          if (existingForecast) {
            await db.insert(recommendations).values({
              runId: activeRunId,
              forecastId: existingForecast.id,
              prepQty: 999,
              confidence: 0.1,
              status: "pending",
              approvedBy: null,
            });
          }
        }
        throw new Error("Transient kitchen-mcp error");
      }
    });

    const secondAttemptResult = await runRecommend(ids.outletA, "2027-10-08", {
      servers: flakyServers,
      beforeWorker: async (runId) => {
        activeRunId = runId;
      },
    });
    expect(secondAttemptResult.state.job("recommend").attempts).toBe(2);
    expect(secondAttemptResult.recommendations).toHaveLength(2);
    expect(secondAttemptResult.recommendations.every((r) => r.prepQty !== 999)).toBe(true);

    // Case 2: get_prep_log fails on every Recommend attempt -> step and run fail with 0 rows saved.
    const brokenServers = wrapPrepLog(async (callNumber) => {
      if (callNumber >= 2) throw new Error("kitchen-mcp unavailable");
    });

    const failResult = await runRecommend(ids.outletA, "2027-10-08", {
      servers: brokenServers,
      expectedRunStatus: "failed",
    });
    expect(failResult.state.job("recommend").status).toBe("failed");
    expect(failResult.state.job("recommend").attempts).toBe(4);
    expect(failResult.recommendations).toHaveLength(0);
  });
});
