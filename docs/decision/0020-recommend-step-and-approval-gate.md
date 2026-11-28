# 0020: Recommend step and approval gate

- Date: 2026-11-28
- Status: accepted

## Context

Recommend is the fourth step of the nightly pipeline (ADR 0017, issue #37, spec #108). Forecast (ADR 0019) predicts tomorrow's demand per menu item as decimal quantities, with an optional LLM adjustment and reason. Kitchens need integer portion counts (`prep_qty`), a confidence signal, a one-line reason, and a safety gate so large changes (>30%) wait for a manager's or owner's approval on Telegram before taking effect. Three choices are hard to reverse and would surprise a reader without context: why Recommend uses no LLM, what the >30% threshold is compared against, and why `recommendation_status` adds `not_required` instead of auto-marking small changes `approved`. The decisions were grilled on 2026-11-28.

## Decision

**Pure fixed-code Recommend step**

- Recommend runs deterministically in fixed code with no LLM call and no fallback handler. Forecast already performed the LLM demand adjustment and recorded its reason; adding a second LLM call would add latency, cost, and failure modes without new information. RAG (`search_knowledge`, #38) and surplus donation routing (`draft_pickup`, P1) remain out of scope here.
- `prep_qty` is `Math.max(0, Math.round(adjusted_qty ?? baseline_qty))` — nearest whole portion with no blanket safety buffer, so recommendations do not systematically create over-prep waste.
- `confidence` is computed deterministically from Forecast's `history_days` and `low_confidence` (`>= 4` → `0.9`, `3` → `0.75`, `2` → `0.65`, `< 2` → `0.4`), minus `0.15` when the Forecast step was `degraded`, clamped to `[0.1, 1.0]`.
- If Postgres or `kitchen-mcp` fails across all 4 attempts, Recommend fails cleanly and stops the run rather than writing partial recommendations.

**Usual prep from matching weekdays as the >30% baseline**

- A >30% change is measured against the item's **usual prep**, not `forecasts.baseline_qty` and not a flat 14-day average. Comparing against `baseline_qty` would miss large operational drops on dry days, while a flat 14-day average would falsely flag normal weekend-vs-weekday volume swings (e.g. Saturday vs Tuesday).
- Usual prep is the mean of `qty_prepped` from `kitchen-mcp`'s `get_prep_log` across the 4 matching weekdays before tomorrow (`target_date - 7, -14, -21, -28`) when at least 2 matching weekdays have records; otherwise the mean across the last 14 days (`business_date - 13` through `business_date`); otherwise `forecasts.baseline_qty`.
- Approval is required when `|prep_qty - usual_prep| / usual_prep * 100 > 30` (strictly greater than 30%). When `usual_prep === 0` and `prep_qty > 0`, approval is required (`change_pct: null`); when both are `0`, no approval is required (`change_pct: 0`).

**`not_required` status and single source of truth**

- `recommendation_status` gains `not_required` (via a Drizzle migration with a hand-written down migration, ADR 0005). Items within ±30% are saved as `not_required` with `approved_by: null`; items over 30% are saved as `pending`. `approved` and `rejected` are written only by a manager or owner with `approved_by` set, preserving the `GLOSSARY.md` rule that agents never grant approval.
- Following ADR 0017 and ADR 0019 ("no number is stored twice"), `recommendations` keeps its existing columns (`id`, `run_id`, `forecast_id`, `prep_qty`, `confidence`, `status`, `approved_by`), saved atomically via `onSave` (deleting prior rows for `run_id` first). Per-item metadata (`recommendation_id`, `forecast_id`, `item_id`, `usual_prep_qty`, `change_pct`, `requires_approval`, `reason`) lives in Recommend's `pipeline_job_results` summary, reusing `forecasts.reason` when non-null or generating a deterministic one-line English reason.

**Fixed-code Telegram approval gate and Lens feedback**

- Recommend stays DB-only (ADR 0017); proactively sending the morning brief and approval cards belongs to the separate delivery job in #39.
- `apps/copilot` renders one Bahasa Indonesia card per `pending` item with two `@anvia/channel` inline actions — **Setuju** (`r:<recommendationId>:a`) and **Tolak** (`r:<recommendationId>:r`) — and handles taps in fixed code without calling the LLM.
- Only a registered `manager` or `owner` of the same outlet may approve or reject; `staff`, unregistered users, and cross-outlet users are refused without mutating the database or card.
- Decisions use one conditional `UPDATE ... WHERE id = $1 AND status = 'pending'` for atomic idempotency, edit the card in place to show the decision without buttons, and attach a best-effort Anvia Lens score `recommendation_decision` (`1` = approved, `0` = rejected, safe metadata `{ recommendation_id, user_id, decision }`) to the pipeline run's `trace_id`.

## Consequences

- Established outlets make only 4 `get_prep_log` calls during Recommend (matching weekdays) and zero LLM calls.
- Because `not_required` is distinct from `approved`, downstream reports and audits can always tell which prep quantities were explicitly approved by a person (`approved_by` is non-null on every `approved` and `rejected` row).
- Because Recommend uses no LLM, no new agent instructions version or changelog entry is needed in `packages/agents`.
- Proactive delivery of approval cards on Telegram waits for #39; until then, cards and tap handling are exercised through automated tests at the `createTurnHandler` seam.
