# Forecast adjustor instructions changelog

Every change to the forecast adjustor's instructions (`src/forecast-adjustor.ts`), or to its
prompt, bumps `FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION` and adds an entry here, newest first. It is
apart from the Copilot's and spike investigator's versions and changelogs (ADR 0019): each agent
changes for different reasons and is judged by different evals. Each forecast adjustment's Lens
trace records the version.

Each entry gives: date, issue, the fingerprint of the instructions text, what was added, changed
or removed, why, and the eval it should move. A test checks that the newest entry's version equals
the constant and that its fingerprint (the first 16 hex characters of the SHA-256 of
`FORECAST_ADJUSTOR_INSTRUCTIONS`) matches the current text, so an edit without a new version fails;
the failure message prints the new fingerprint. The prompt is not fingerprinted: bump the version
for prompt changes by hand.

## 2026-11-28.1

- Date: 2026-11-28
- Issue: #102 (ADR 0019)
- Fingerprint: `6c951bddf551f50f`
- Added: the first instructions. The adjustor adjusts tomorrow's baseline portion counts for an
  outlet in a single batch call when Indonesian calendar events (holidays or Ramadan) or
  significant rain are expected; it omits unchanged items, requires a short English reason for every
  adjusted item, forbids negative quantities or unknown/duplicate item IDs, rounds to 1 decimal
  place, and answers with a JSON object only.
- Why: Forecast adjusts deterministic weekday baselines for calendar and rain context (#36, #99,
  #102).
- Eval to move: none yet. Forecast accuracy against held-out mock sales (MAPE eval) is follow-up
  work (#63).
