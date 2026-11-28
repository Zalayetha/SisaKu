import { randomUUID } from "node:crypto";
import type { McpServer } from "@anvia/core/mcp";
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
/** Tomorrow's precipitation (mm) at or above which rain triggers LLM adjustment (ADR 0019). */
export const RAIN_TRIGGER_MM = 5;
/** Tomorrow's rain probability (%) at or above which rain triggers LLM adjustment (ADR 0019). */
export const RAIN_TRIGGER_PROBABILITY_PCT = 60;
/** Time limit per Open-Meteo MCP call before degrading to unavailable. */
export const WEATHER_TIMEOUT_MS = 10_000;

type Coordinates = { readonly latitude: number; readonly longitude: number };

/** Fallback coordinates for major Indonesian cities when Open-Meteo geocoding finds no match. */
const INDONESIAN_CITIES: readonly [string, Coordinates][] = [
  ["jakarta selatan", { latitude: -6.2615, longitude: 106.8106 }],
  ["jakarta pusat", { latitude: -6.1862, longitude: 106.8341 }],
  ["jakarta barat", { latitude: -6.1674, longitude: 106.7637 }],
  ["jakarta timur", { latitude: -6.225, longitude: 106.9004 }],
  ["jakarta utara", { latitude: -6.1384, longitude: 106.864 }],
  ["jakarta", { latitude: -6.2088, longitude: 106.8456 }],
  ["bandung", { latitude: -6.9175, longitude: 107.6191 }],
  ["surabaya", { latitude: -7.2575, longitude: 112.7521 }],
  ["yogyakarta", { latitude: -7.7956, longitude: 110.3695 }],
  ["semarang", { latitude: -6.9667, longitude: 110.4167 }],
  ["medan", { latitude: 3.5952, longitude: 98.6722 }],
  ["denpasar", { latitude: -8.6705, longitude: 115.2126 }],
  ["bali", { latitude: -8.4095, longitude: 115.1889 }],
  ["makassar", { latitude: -5.1477, longitude: 119.4327 }],
  ["tangerang", { latitude: -6.1783, longitude: 106.6319 }],
  ["bekasi", { latitude: -6.2383, longitude: 106.9756 }],
  ["depok", { latitude: -6.4025, longitude: 106.7942 }],
  ["bogor", { latitude: -6.5971, longitude: 106.806 }],
];

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

export type ForecastWeatherSummary = z.infer<typeof forecastWeatherSummary>;
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

function fallbackIndonesianCity(location: string): Coordinates | undefined {
  const parts = location.toLowerCase().split(",").reverse();
  for (const part of parts) {
    let best: { coords: Coordinates; end: number; length: number } | undefined;
    for (const [city, coords] of INDONESIAN_CITIES) {
      const pattern = new RegExp(`\\b${city}\\b`, "g");
      for (const match of part.matchAll(pattern)) {
        const end = match.index + city.length;
        if (!best || end > best.end || (end === best.end && city.length > best.length)) {
          best = { coords, end, length: city.length };
        }
      }
    }
    if (best) return best.coords;
  }
  return undefined;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type GeocodingResponse = {
  results?: { latitude?: unknown; longitude?: unknown }[];
};

type WeatherForecastResponse = {
  daily?: {
    time?: unknown[];
    precipitation_sum?: unknown[];
    precipitation_probability_max?: unknown[];
  };
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Fetches tomorrow's daily rain forecast via Open-Meteo MCP. Never throws: missing location
 * returns `no_location`; any connection, geocoding, timeout, or parse failure logs a warning and
 * returns `unavailable` so forecasting continues without weather (ADR 0019).
 */
async function fetchTomorrowWeather({
  weatherServer,
  location,
  timezone,
  targetDate,
  log,
}: {
  weatherServer?: McpServer | undefined;
  location: string | null;
  timezone: string;
  targetDate: string;
  log: (message: string, error?: unknown) => void;
}): Promise<ForecastWeatherSummary> {
  const trimmed = location?.trim();
  if (!trimmed) {
    log("Outlet has no location configured; continuing without weather.");
    return { status: "no_location" };
  }
  if (!weatherServer) {
    log(`Open-Meteo MCP server is unavailable for "${trimmed}"; continuing without weather.`);
    return { status: "unavailable" };
  }

  const servers = [weatherServer];
  let coords: Coordinates | undefined;
  try {
    const geo = await withTimeout(
      callMcpTool<GeocodingResponse>(servers, "geocoding", {
        name: trimmed,
        count: 1,
        countryCode: "ID",
      }),
      WEATHER_TIMEOUT_MS,
      "Open-Meteo geocoding",
    );
    const first = geo.results?.[0];
    if (
      first &&
      typeof first.latitude === "number" &&
      Number.isFinite(first.latitude) &&
      typeof first.longitude === "number" &&
      Number.isFinite(first.longitude)
    ) {
      coords = { latitude: first.latitude, longitude: first.longitude };
    }
  } catch (error) {
    log(`Open-Meteo geocoding failed for "${trimmed}"; trying city fallback.`, error);
  }

  coords ??= fallbackIndonesianCity(trimmed);
  if (!coords) {
    log(`Could not resolve coordinates for outlet location "${trimmed}"; skipping weather.`);
    return { status: "unavailable" };
  }

  try {
    const forecast = await withTimeout(
      callMcpTool<WeatherForecastResponse>(servers, "weather_forecast", {
        latitude: coords.latitude,
        longitude: coords.longitude,
        daily: ["precipitation_sum", "precipitation_probability_max"],
        timezone,
        start_date: targetDate,
        end_date: targetDate,
      }),
      WEATHER_TIMEOUT_MS,
      "Open-Meteo weather_forecast",
    );
    const daily = forecast.daily;
    const times = Array.isArray(daily?.time) ? daily.time : [];
    const index = times.indexOf(targetDate);
    if (index === -1) {
      log(`Open-Meteo weather_forecast response did not include ${targetDate}.`);
      return { status: "unavailable" };
    }
    const rawMm = finiteNonNegative(daily?.precipitation_sum?.[index]);
    const rawProb = finiteNonNegative(daily?.precipitation_probability_max?.[index]);
    if (rawMm === undefined && rawProb === undefined) {
      log(`Open-Meteo weather_forecast had no precipitation numbers for ${targetDate}.`);
      return { status: "unavailable" };
    }
    const triggered =
      (rawMm !== undefined && rawMm >= RAIN_TRIGGER_MM) ||
      (rawProb !== undefined && rawProb >= RAIN_TRIGGER_PROBABILITY_PCT);
    const precipitation_mm = rawMm !== undefined ? round1(rawMm) : undefined;
    const rain_probability_pct =
      rawProb !== undefined ? Math.min(100, Math.round(rawProb)) : undefined;
    return {
      status: "ok",
      ...(precipitation_mm !== undefined ? { precipitation_mm } : {}),
      ...(rain_probability_pct !== undefined ? { rain_probability_pct } : {}),
      triggered,
    };
  } catch (error) {
    log(`Open-Meteo weather_forecast failed for "${trimmed}"; continuing without weather.`, error);
    return { status: "unavailable" };
  }
}

export type ForecastStepDeps = {
  /** Optional Open-Meteo MCP server for tomorrow's rain forecast (ADR 0019). */
  readonly weatherServer?: McpServer | undefined;
  readonly log?: (message: string, error?: unknown) => void;
};

/**
 * The Forecast step: computes deterministic statistical baselines (4 matching weekdays of sales,
 * or 14-day prep-log fallback with `low_confidence: true` when fewer than 2 matching weekdays
 * exist), fetches tomorrow's rain forecast via Open-Meteo MCP when available, persists rows to
 * `forecasts` via `onSave`, and returns summary metadata (ADR 0019).
 */
export function createForecastStep(deps: ForecastStepDeps = {}): StepDefinition<ForecastOutput> {
  const log =
    deps.log ?? ((message: string, error?: unknown) => console.warn(message, error ?? ""));
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
        for (const prepLog of logs) {
          for (const row of prepLog.rows) {
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

      const weather = await fetchTomorrowWeather({
        weatherServer: deps.weatherServer,
        location: run.location,
        timezone: run.timezone,
        targetDate: target_date,
        log,
      });

      onSave(async (tx) => {
        await tx.delete(forecasts).where(eq(forecasts.runId, run.id));
        await tx.insert(forecasts).values(rowsToInsert);
      });

      return {
        target_date,
        weather,
        calendar_events: [],
        llm_called: false,
        adjusted_count: 0,
        items,
      };
    },
  };
}
