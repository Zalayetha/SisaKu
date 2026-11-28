# 0019: Forecast step baseline and LLM adjustment

- Date: 2026-11-28
- Status: accepted

## Context

Forecast is the third step of the nightly pipeline (ADR 0017, issue #36, spec #99). Every night it predicts tomorrow's demand (`business_date + 1 day`) per menu item at each outlet so Recommend (#37) can set prep quantities and flag large changes. Plain statistical averages miss predictable demand shifts from Indonesian holidays, Ramadan, and rain, while new outlets lack multi-week sales history. At the same time, an outage in the external weather service or the LLM must never stop a pipeline run from producing a usable baseline. The decisions were grilled on 2026-11-28 and split into four slices: #100 (baselines and prep fallback), #101 (Open-Meteo weather client), #102 (calendar and LLM adjustor), and #103 (degraded baseline fallback).

## Decision

**Fixed code computes baselines and gathers context; the LLM only adjusts**

- Fixed code reads the outlet's menu, sales, and (when needed) prep logs through `kitchen-mcp`, computes each item's deterministic baseline, checks tomorrow's Indonesian calendar context (`get_calendar`), and fetches tomorrow's rain forecast through an optional Open-Meteo MCP client.
- On a normal, dry day with no calendar events—or when no item has `baseline_qty > 0`—no LLM call is made.
- When a holiday, Ramadan, or significant rain is present, a single batch call per outlet to the forecast adjustor agent in `packages/agents` proposes item adjustments, each with a stated English reason.

**Four matching weekdays, and new-outlet prep fallback**

- An item's baseline is the mean of `qty_sold` across the four matching weekdays before tomorrow (`target_date - 7`, `-14`, `-21`, `-28`), rounded to 1 decimal place. Missing or closed days are excluded as long as at least 2 matching weekdays have sales records (`low_confidence: false`).
- With fewer than 2 matching weekdays (`low_confidence: true`), the step keeps `kitchen-mcp` unchanged and queries `get_prep_log` in parallel over the last 14 days (`business_date - 13` through `business_date`), averaging any available `qty_prepped` for that item rounded to 1 decimal place (or `0` if none exist). Items with `baseline_qty === 0` are excluded from LLM adjustment; `low_confidence` items with `baseline_qty > 0` may still be adjusted.

**Optional Open-Meteo MCP client**

- `connectMcpServers()` remains strictly for required servers (`kitchen`, `impact`). A separate optional `connectWeatherMcp()` helper connects to `open-meteo-mcp-server` over Streamable HTTP (`WEATHER_MCP_URL`) or stdio, and degrades gracefully if unreachable so it never blocks worker startup.
- `PipelineRun` carries `outlets.location`, resolved via Open-Meteo's `geocoding` tool (with a known Indonesian city fallback). Rain triggers LLM adjustment when tomorrow's `precipitation_sum >= 5` mm or `precipitation_probability_max >= 60`%. Missing location, geocoding errors, or tool failures/timeouts log a warning and proceed without weather context.

**Storage, validation, fallback, and versioning**

- Each item's `baseline_qty`, `adjusted_qty`, `reason`, and `model` are written to `forecasts` via `onSave` (deleting prior rows for the run first, using pre-generated UUIDs). Unadjusted items store `adjusted_qty = baseline_qty`, `reason = null`, `model = "baseline"`; adjusted items store the rounded quantity, stated reason, and model ID.
- Following ADR 0017 ("no number is stored twice"), `pipeline_job_results` stores only summary metadata: `target_date`, `weather`, `calendar_events`, `llm_called`, `adjusted_count`, and per-item `{ forecast_id, item_id, low_confidence, history_days }`.
- Malformed JSON, negative quantities, unknown/duplicate item IDs, edits to `0`-baseline items, or adjustments without a non-empty reason throw an ordinary error so BullMQ retries. After 4 failed attempts, the fallback recomputes deterministic baselines with no LLM, saves `adjusted_qty = baseline_qty`, `reason = "AI adjustment unavailable today"`, `model = "baseline"`, and marks the step `degraded` so the pipeline run continues.
- The forecast adjustor agent has its own instructions version (`FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION`), changelog (`FORECAST-ADJUSTOR-CHANGELOG.md`), and SHA-256 fingerprint test in `packages/agents`.

## Consequences

- Normal dry nights make zero LLM calls, keeping nightly runs fast and inexpensive.
- Established outlets with at least 2 matching weekdays make zero `get_prep_log` calls during Forecast; new outlets make at most 14 parallel `get_prep_log` calls without changing `kitchen-mcp`.
- Downstream steps (`recommend`, `report`) read `low_confidence` and `forecast_id` from `pipeline_job_results` and read forecast quantities from `forecasts`, keeping a single source of truth.
- Forecast quality against held-out mock sales (MAPE eval) remains a separate follow-up (#63).
