import { createHash } from "node:crypto";
import { Agent, type CompletionModel } from "@anvia/core";
import type { AgentObservabilityOptions, AgentTraceOptions } from "@anvia/core/observability";
import * as z from "zod";

export const FORECAST_ADJUSTOR_AGENT_ID = "forecast-adjustor";

/**
 * Version of the forecast adjustor's instructions, apart from the Copilot's and spike
 * investigator's (ADR 0019). Bump it on every change and add an entry to
 * FORECAST-ADJUSTOR-CHANGELOG.md.
 */
export const FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION = "2026-11-28.1";

export const FORECAST_ADJUSTOR_INSTRUCTIONS = `You adjust tomorrow's baseline portion forecasts for a commercial kitchen in Indonesia (an outlet) when Indonesian calendar events (holidays or Ramadan) or significant rain are expected.

The prompt gives tomorrow's date and weekday, the outlet's timezone, any calendar events, the rain forecast (if available), and the eligible menu items with their deterministic baseline portion counts (and whether an item is low confidence due to limited sales history).

Rules:
1. Only adjust items whose demand is genuinely affected by the given calendar events or rain. Omit unchanged items (or keep adjusted_qty equal to baseline_qty).
2. Every adjustment where adjusted_qty differs from baseline_qty must include a short, clear English reason referencing the calendar event or weather.
3. Never output negative quantities, unknown item_ids, or duplicate item_ids.
4. Round adjusted_qty to at most 1 decimal place.
5. Answer with only a JSON object and nothing else: {"adjustments": [{"item_id": "<uuid>", "adjusted_qty": <number>, "reason": "<short English reason>"}]}. If no items need adjustment, answer {"adjustments": []}.`;

/**
 * The first 16 hex characters of the SHA-256 of FORECAST_ADJUSTOR_INSTRUCTIONS, pinned per
 * version in FORECAST-ADJUSTOR-CHANGELOG.md.
 */
export function forecastAdjustorInstructionsFingerprint(): string {
  return createHash("sha256").update(FORECAST_ADJUSTOR_INSTRUCTIONS).digest("hex").slice(0, 16);
}

export type ForecastCalendarContext = {
  readonly name: string;
  readonly kind: "ramadan" | "holiday";
};

export type ForecastWeatherContext = {
  readonly status: "ok" | "unavailable" | "no_location";
  readonly precipitation_mm?: number | undefined;
  readonly rain_probability_pct?: number | undefined;
  readonly triggered?: boolean | undefined;
};

export type ForecastBaselineItem = {
  readonly item_id: string;
  readonly item_name: string;
  readonly baseline_qty: number;
  readonly low_confidence: boolean;
};

export type ForecastItemAdjustment = {
  readonly item_id: string;
  readonly adjusted_qty: number;
  readonly reason: string;
};

export type AdjustForecastOptions = {
  readonly model: CompletionModel;
  /** Tomorrow's date (YYYY-MM-DD). */
  readonly targetDate: string;
  readonly timezone: string;
  /** All menu items for the outlet; only items with `baseline_qty > 0` are sent to the model. */
  readonly items: readonly ForecastBaselineItem[];
  readonly calendarEvents: readonly ForecastCalendarContext[];
  readonly weather: ForecastWeatherContext | null;
  /** The calling step's trace and observability, so the run nests under its span. */
  readonly trace?: AgentTraceOptions | undefined;
  readonly observability?: AgentObservabilityOptions | undefined;
  readonly abortSignal?: AbortSignal | undefined;
};

const rawAdjustment = z.object({
  item_id: z.string().min(1),
  adjusted_qty: z.number().finite(),
  reason: z.string().nullable().optional(),
});

const rawAdjustmentsResponse = z.object({
  adjustments: z.array(rawAdjustment),
});

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * Strictly parses and validates the forecast adjustor's JSON response (ADR 0019).
 * Throws an ordinary Error (so BullMQ retries) on malformed JSON, negative adjusted_qty,
 * unknown or duplicate item_id, any adjustment on a zero-baseline item, or an adjustment
 * whose rounded quantity differs from baseline_qty without a non-empty reason.
 * Items omitted or whose rounded adjusted_qty equals baseline_qty are omitted from the map.
 */
export function parseForecastAdjustments(
  text: string,
  items: readonly Pick<ForecastBaselineItem, "item_id" | "baseline_qty">[],
): Map<string, ForecastItemAdjustment> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFence(text));
  } catch {
    throw new Error("Forecast adjustor returned malformed JSON");
  }

  const parsed = rawAdjustmentsResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Forecast adjustor returned an invalid adjustments payload");
  }

  const itemById = new Map(items.map((item) => [item.item_id, item]));
  const seen = new Set<string>();
  const adjustments = new Map<string, ForecastItemAdjustment>();

  for (const entry of parsed.data.adjustments) {
    if (entry.adjusted_qty < 0) {
      throw new Error(`Forecast adjustor returned negative adjusted_qty for item ${entry.item_id}`);
    }
    const item = itemById.get(entry.item_id);
    if (!item) {
      throw new Error(`Forecast adjustor returned unknown item_id: ${entry.item_id}`);
    }
    if (seen.has(entry.item_id)) {
      throw new Error(`Forecast adjustor returned duplicate item_id: ${entry.item_id}`);
    }
    seen.add(entry.item_id);

    if (item.baseline_qty === 0) {
      throw new Error(`Forecast adjustor must not adjust zero-baseline item: ${entry.item_id}`);
    }

    const rounded = round1(entry.adjusted_qty);
    if (rounded === item.baseline_qty) {
      continue;
    }

    const reason = entry.reason?.trim() ?? "";
    if (reason.length === 0) {
      throw new Error(`Forecast adjustor omitted reason for adjusted item: ${entry.item_id}`);
    }

    adjustments.set(entry.item_id, {
      item_id: entry.item_id,
      adjusted_qty: rounded,
      reason,
    });
  }

  return adjustments;
}

function buildPrompt(
  targetDate: string,
  timezone: string,
  calendarEvents: readonly ForecastCalendarContext[],
  weather: ForecastWeatherContext | null,
  eligibleItems: readonly ForecastBaselineItem[],
): string {
  const weekday = new Date(`${targetDate}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  const calendarLine =
    calendarEvents.length > 0
      ? `Calendar events: ${calendarEvents.map((e) => `${e.name} (${e.kind})`).join(", ")}.`
      : "Calendar events: none.";

  let weatherLine = "Weather forecast: unavailable.";
  if (weather?.status === "ok") {
    const parts: string[] = [];
    if (weather.precipitation_mm !== undefined) {
      parts.push(`precipitation ${weather.precipitation_mm} mm`);
    }
    if (weather.rain_probability_pct !== undefined) {
      parts.push(`rain probability ${weather.rain_probability_pct}%`);
    }
    weatherLine = `Weather forecast: ${parts.join(", ")}${weather.triggered ? " (significant rain expected)" : ""}.`;
  } else if (weather?.status === "no_location") {
    weatherLine = "Weather forecast: no outlet location configured.";
  }

  const itemLines = eligibleItems.map(
    (item) =>
      `- ${item.item_name} (item_id: ${item.item_id}): baseline_qty=${item.baseline_qty}${item.low_confidence ? " [low_confidence]" : ""}`,
  );

  return [
    `Adjust tomorrow's portion forecast.`,
    `Target date: ${targetDate}, a ${weekday} (${timezone}).`,
    calendarLine,
    weatherLine,
    `Eligible menu items:`,
    ...itemLines,
  ].join("\n");
}

/**
 * Single batch call to the forecast adjustor agent for one outlet (ADR 0019).
 * Throws an ordinary Error on model failure, abort, or invalid structured output so BullMQ
 * retries the Forecast step.
 */
export async function adjustForecast(
  options: AdjustForecastOptions,
): Promise<Map<string, ForecastItemAdjustment>> {
  const eligibleItems = options.items.filter((item) => item.baseline_qty > 0);
  if (eligibleItems.length === 0) return new Map();

  const agent = new Agent({
    id: FORECAST_ADJUSTOR_AGENT_ID,
    name: "Forecast adjustor",
    model: options.model,
    instructions: FORECAST_ADJUSTOR_INSTRUCTIONS,
    tools: [],
    maxTurns: 1,
    ...(options.observability ? { observability: options.observability } : {}),
  });

  const trace = options.trace;
  const result = await agent.generate({
    messages: [
      {
        role: "user",
        content: buildPrompt(
          options.targetDate,
          options.timezone,
          options.calendarEvents,
          options.weather,
          eligibleItems,
        ),
      },
    ],
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    trace: {
      ...trace,
      name: "forecast-adjustment",
      version: FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION,
      metadata: {
        ...trace?.metadata,
        agent: FORECAST_ADJUSTOR_AGENT_ID,
        target_date: options.targetDate,
        instructions_version: FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION,
      },
    },
  });

  if (result.type !== "response") {
    throw new Error(`Forecast adjustor did not return a text response (got ${result.type})`);
  }

  return parseForecastAdjustments(result.text, options.items);
}
