import { randomUUID } from "node:crypto";
import { callMcpTool } from "@sisaku/agents";
import { forecasts, pipelineJobs, recommendations } from "@sisaku/db";
import type { GetPrepLogInput, GetPrepLogOutput } from "@sisaku/kitchen-mcp";
import { addDays } from "@sisaku/shared";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import {
  MIN_HISTORY_DAYS,
  PREP_FALLBACK_DAYS,
  SAME_WEEKDAY_WEEKS,
  type ForecastOutput,
} from "./forecast";
import { PermanentError, type StepContext, type StepDefinition } from "./steps";

/** Percentage change strictly above this requires manager/owner approval (ADR 0020). */
export const APPROVAL_THRESHOLD_PCT = 30;
/** Confidence reduction applied when the Forecast step degraded to plain baselines. */
export const DEGRADED_CONFIDENCE_PENALTY = 0.15;
export const MIN_CONFIDENCE = 0.1;
export const MAX_CONFIDENCE = 1.0;

export const recommendItemSummary = z.object({
  recommendation_id: z.uuid(),
  forecast_id: z.uuid(),
  item_id: z.uuid(),
  usual_prep_qty: z.number().nonnegative(),
  change_pct: z.number().nullable(),
  requires_approval: z.boolean(),
  reason: z.string().min(1),
});

/**
 * Summary output of the Recommend step stored in `pipeline_job_results` (ADR 0017, ADR 0020).
 * Prep quantities, confidence, status, and approver live in the `recommendations` table.
 */
export const recommendOutput = z.object({
  target_date: z.iso.date(),
  total_items: z.number().int().nonnegative(),
  pending_approval_count: z.number().int().nonnegative(),
  items: z.array(recommendItemSummary),
});

export type RecommendItemSummary = z.infer<typeof recommendItemSummary>;
export type RecommendOutput = z.infer<typeof recommendOutput>;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function computeConfidence(historyDays: number, lowConfidence: boolean, degraded: boolean): number {
  let base: number;
  if (lowConfidence || historyDays < 2) {
    base = 0.4;
  } else if (historyDays === 2) {
    base = 0.65;
  } else if (historyDays === 3) {
    base = 0.75;
  } else {
    base = 0.9;
  }
  const adjusted = degraded ? base - DEGRADED_CONFIDENCE_PENALTY : base;
  return round2(Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, adjusted)));
}

function computeChange(
  prepQty: number,
  usualPrepQty: number,
): { changePct: number | null; requiresApproval: boolean } {
  if (usualPrepQty === 0) {
    if (prepQty === 0) return { changePct: 0, requiresApproval: false };
    return { changePct: null, requiresApproval: true };
  }
  const rawChangePct = ((prepQty - usualPrepQty) / usualPrepQty) * 100;
  return {
    changePct: round1(rawChangePct),
    requiresApproval: Math.abs(rawChangePct) > APPROVAL_THRESHOLD_PCT,
  };
}

function fallbackReason(historyDays: number, lowConfidence: boolean, baselineQty: number): string {
  if (lowConfidence) {
    return baselineQty > 0
      ? "Based on 14-day usual prep (low confidence)"
      : "No recent sales or prep history (low confidence)";
  }
  return `Based on ${historyDays}-week weekday average`;
}

function saveRecommendationRows(
  onSave: StepContext["onSave"],
  runId: string,
  rows: readonly (typeof recommendations.$inferInsert)[],
): void {
  onSave(async (tx) => {
    await tx.delete(recommendations).where(eq(recommendations.runId, runId));
    if (rows.length > 0) {
      await tx.insert(recommendations).values([...rows]);
    }
  });
}

/**
 * Turns each persisted Forecast row into an integer prep recommendation with confidence,
 * usual-prep comparison, and >30% approval gating. Pure fixed code with no LLM call (ADR 0020).
 */
export const recommendStep: StepDefinition<RecommendOutput> = {
  name: "recommend",
  output: recommendOutput,
  async run({ run, db, outputs, servers, onSave }) {
    const forecast = outputs.forecast as ForecastOutput;

    if (forecast.items.length === 0) {
      saveRecommendationRows(onSave, run.id, []);
      return {
        target_date: forecast.target_date,
        total_items: 0,
        pending_approval_count: 0,
        items: [],
      };
    }

    const [forecastRows, forecastJobRows] = await Promise.all([
      db.select().from(forecasts).where(eq(forecasts.runId, run.id)),
      db
        .select({ status: pipelineJobs.status })
        .from(pipelineJobs)
        .where(and(eq(pipelineJobs.runId, run.id), eq(pipelineJobs.step, "forecast"))),
    ]);

    const forecastById = new Map(forecastRows.map((row) => [row.id, row]));
    for (const item of forecast.items) {
      if (!forecastById.has(item.forecast_id)) {
        throw new PermanentError(`Forecast row ${item.forecast_id} for run ${run.id} is missing`);
      }
    }

    const forecastDegraded = forecastJobRows[0]?.status === "degraded";
    const outlet_id = run.outletId;

    const logsByDate = new Map<string, GetPrepLogOutput>();
    async function loadPrepByItem(dates: readonly string[]): Promise<Map<string, number[]>> {
      const missingDates = dates.filter((date) => !logsByDate.has(date));
      const fetched = await Promise.all(
        missingDates.map(async (date) => {
          const log = await callMcpTool<GetPrepLogOutput>(servers, "get_prep_log", {
            outlet_id,
            date,
          } satisfies GetPrepLogInput);
          return [date, log] as const;
        }),
      );
      for (const [date, log] of fetched) {
        logsByDate.set(date, log);
      }
      const byItem = new Map<string, number[]>();
      for (const date of dates) {
        const log = logsByDate.get(date);
        if (!log) continue;
        for (const row of log.rows) {
          const list = byItem.get(row.item_id) ?? [];
          list.push(row.qty_prepped);
          byItem.set(row.item_id, list);
        }
      }
      return byItem;
    }

    const weekdayDates = Array.from({ length: SAME_WEEKDAY_WEEKS }, (_, i) =>
      addDays(forecast.target_date, -7 * (SAME_WEEKDAY_WEEKS - i)),
    );
    const weekdayPrepByItem = await loadPrepByItem(weekdayDates);

    const needsPrepFallback = forecast.items.some(
      (item) => (weekdayPrepByItem.get(item.item_id)?.length ?? 0) < MIN_HISTORY_DAYS,
    );

    const fallbackPrepByItem = needsPrepFallback
      ? await loadPrepByItem(
          Array.from({ length: PREP_FALLBACK_DAYS }, (_, i) =>
            addDays(run.businessDate, -(PREP_FALLBACK_DAYS - 1 - i)),
          ),
        )
      : new Map<string, number[]>();

    const items: RecommendItemSummary[] = [];
    const rowsToInsert: (typeof recommendations.$inferInsert)[] = [];
    let pendingApprovalCount = 0;

    for (const item of forecast.items) {
      const forecastRow = forecastById.get(item.forecast_id)!;
      const prepQty = Math.max(0, Math.round(forecastRow.adjustedQty ?? forecastRow.baselineQty));

      const weekdayPreps = weekdayPrepByItem.get(item.item_id) ?? [];
      const fallbackPreps = fallbackPrepByItem.get(item.item_id) ?? [];
      let usualPrepQty: number;
      if (weekdayPreps.length >= MIN_HISTORY_DAYS) {
        usualPrepQty = round1(mean(weekdayPreps));
      } else if (fallbackPreps.length > 0) {
        usualPrepQty = round1(mean(fallbackPreps));
      } else {
        usualPrepQty = forecastRow.baselineQty;
      }

      const { changePct, requiresApproval } = computeChange(prepQty, usualPrepQty);
      if (requiresApproval) pendingApprovalCount += 1;

      const confidence = computeConfidence(
        item.history_days,
        item.low_confidence,
        forecastDegraded,
      );
      const reason =
        forecastRow.reason && forecastRow.reason.trim().length > 0
          ? forecastRow.reason
          : fallbackReason(item.history_days, item.low_confidence, forecastRow.baselineQty);

      const recommendationId = randomUUID();
      items.push({
        recommendation_id: recommendationId,
        forecast_id: item.forecast_id,
        item_id: item.item_id,
        usual_prep_qty: usualPrepQty,
        change_pct: changePct,
        requires_approval: requiresApproval,
        reason,
      });

      rowsToInsert.push({
        id: recommendationId,
        runId: run.id,
        forecastId: item.forecast_id,
        prepQty,
        confidence,
        status: requiresApproval ? "pending" : "not_required",
        approvedBy: null,
      });
    }

    saveRecommendationRows(onSave, run.id, rowsToInsert);

    return {
      target_date: forecast.target_date,
      total_items: items.length,
      pending_approval_count: pendingApprovalCount,
      items,
    };
  },
};
