import { randomUUID } from "node:crypto";
import { callMcpTool } from "@sisaku/agents";
import { forecasts } from "@sisaku/db";
import type {
  GetMenuInput,
  GetMenuOutput,
  GetPrepLogInput,
  GetPrepLogOutput,
  GetSalesInput,
  GetSalesOutput,
} from "@sisaku/kitchen-mcp";
import { eq } from "drizzle-orm";
import * as z from "zod";
import type { StepDefinition } from "./steps";

/** Matching weekdays looked back from the target date (1 to 4 weeks prior). */
export const SAME_WEEKDAY_WEEKS = 4;
/** Fewer matching weekdays with sales than this triggers the prep-log fallback. */
export const MIN_HISTORY_DAYS = 2;
/** Days of prep logs averaged for items with little sales history. */
export const PREP_FALLBACK_DAYS = 14;
/** `forecasts.model` when no LLM adjustment was applied. */
export const BASELINE_MODEL = "baseline";

export const forecastWeatherSummary = z.object({
  status: z.enum(["ok", "unavailable", "no_location"]),
  precipitation_mm: z.number().nonnegative().optional(),
  rain_probability_pct: z.number().min(0).max(100).optional(),
  triggered: z.boolean().optional(),
});

export const forecastCalendarEvent = z.object({
  name: z.string(),
  kind: z.enum(["ramadan", "holiday"]),
});

export const forecastItemSummary = z.object({
  forecast_id: z.uuid(),
  item_id: z.uuid(),
  low_confidence: z.boolean(),
  history_days: z.number().int().nonnegative(),
});

/**
 * Summary output of the Forecast step stored in `pipeline_job_results` (ADR 0017, ADR 0019).
 * Forecast quantities, reasons, and models live only in the `forecasts` table.
 */
export const forecastOutput = z.object({
  target_date: z.iso.date(),
  weather: forecastWeatherSummary.nullable(),
  calendar_events: z.array(forecastCalendarEvent),
  llm_called: z.boolean(),
  adjusted_count: z.number().int().nonnegative(),
  items: z.array(forecastItemSummary),
});

export type ForecastItemSummary = z.infer<typeof forecastItemSummary>;
export type ForecastOutput = z.infer<typeof forecastOutput>;

/** The day `offset` days from `date` (YYYY-MM-DD). */
function addDays(date: string, offset: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Rounds a quantity to 1 decimal place. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The Forecast step: computes deterministic statistical baselines (4 matching weekdays of sales,
 * or 14-day prep-log fallback with `low_confidence: true` when fewer than 2 matching weekdays
 * exist), persists rows to `forecasts` via `onSave`, and returns summary metadata (ADR 0019).
 */
export function createForecastStep(): StepDefinition<ForecastOutput> {
  return {
    name: "forecast",
    output: forecastOutput,
    async run({ run, servers, onSave }) {
      const outlet_id = run.outletId;
      const target_date = addDays(run.businessDate, 1);

      const menu = await callMcpTool<GetMenuOutput>(servers, "get_menu", {
        outlet_id,
      } satisfies GetMenuInput);

      if (menu.items.length === 0) {
        onSave(async (tx) => {
          await tx.delete(forecasts).where(eq(forecasts.runId, run.id));
        });
        return {
          target_date,
          weather: null,
          calendar_events: [],
          llm_called: false,
          adjusted_count: 0,
          items: [],
        };
      }

      const weekdayDates = Array.from({ length: SAME_WEEKDAY_WEEKS }, (_, i) =>
        addDays(target_date, -7 * (SAME_WEEKDAY_WEEKS - i)),
      );
      const weekdaySet = new Set(weekdayDates);

      const sold = await callMcpTool<GetSalesOutput>(servers, "get_sales", {
        outlet_id,
        from: weekdayDates[0]!,
        to: weekdayDates[weekdayDates.length - 1]!,
      } satisfies GetSalesInput);

      const salesByItem = new Map<string, number[]>();
      for (const row of sold.rows) {
        if (!weekdaySet.has(row.date)) continue;
        const list = salesByItem.get(row.item_id) ?? [];
        list.push(row.qty_sold);
        salesByItem.set(row.item_id, list);
      }

      const needsPrepFallback = menu.items.some(
        (item) => (salesByItem.get(item.id)?.length ?? 0) < MIN_HISTORY_DAYS,
      );

      const prepByItem = new Map<string, number[]>();
      if (needsPrepFallback) {
        const prepDates = Array.from({ length: PREP_FALLBACK_DAYS }, (_, i) =>
          addDays(run.businessDate, -(PREP_FALLBACK_DAYS - 1 - i)),
        );
        const logs = await Promise.all(
          prepDates.map((date) =>
            callMcpTool<GetPrepLogOutput>(servers, "get_prep_log", {
              outlet_id,
              date,
            } satisfies GetPrepLogInput),
          ),
        );
        for (const log of logs) {
          for (const row of log.rows) {
            const list = prepByItem.get(row.item_id) ?? [];
            list.push(row.qty_prepped);
            prepByItem.set(row.item_id, list);
          }
        }
      }

      const items: ForecastItemSummary[] = [];
      const rowsToInsert: (typeof forecasts.$inferInsert)[] = [];

      for (const item of menu.items) {
        const forecast_id = randomUUID();
        const itemSales = salesByItem.get(item.id) ?? [];
        const history_days = itemSales.length;
        const low_confidence = history_days < MIN_HISTORY_DAYS;

        let baselineQty: number;
        if (!low_confidence) {
          baselineQty = round1(mean(itemSales));
        } else {
          const itemPreps = prepByItem.get(item.id) ?? [];
          baselineQty = itemPreps.length > 0 ? round1(mean(itemPreps)) : 0;
        }

        items.push({
          forecast_id,
          item_id: item.id,
          low_confidence,
          history_days,
        });
        rowsToInsert.push({
          id: forecast_id,
          runId: run.id,
          outletId: outlet_id,
          itemId: item.id,
          date: target_date,
          baselineQty,
          adjustedQty: baselineQty,
          reason: null,
          model: BASELINE_MODEL,
        });
      }

      onSave(async (tx) => {
        await tx.delete(forecasts).where(eq(forecasts.runId, run.id));
        await tx.insert(forecasts).values(rowsToInsert);
      });

      return {
        target_date,
        weather: null,
        calendar_events: [],
        llm_called: false,
        adjusted_count: 0,
        items,
      };
    },
  };
}
