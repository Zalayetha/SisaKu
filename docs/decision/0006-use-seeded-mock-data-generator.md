# 0006: Use a seeded, deterministic mock-data generator

- Date: 2026-11-20
- Status: accepted

## Context

SisaKu has no real outlet data yet. Agents, forecasts and evals need realistic sales, prep and waste history to run against. The data must be the same on every machine and in CI, so test and eval results can be compared. Forecast evals also need demand changes that the model cannot predict from the calendar, plus a record of where those changes are, so they can be scored.

## Decision

- **Package:** `packages/mock-data` (`@sisaku/mock-data`) generates the data and loads it through `@sisaku/db`. Run it with `pnpm --filter @sisaku/mock-data seed [--seed N] [--start YYYY-MM-DD] [--days N] [--reset] [--dry-run]`.
- **Determinism:** a small seeded PRNG (`src/rng.ts`, mulberry32 with an FNV-1a string hash) produces every value, including UUIDs. The same seed always gives the same dataset. Each outlet has its own stream (`<seed>:outlet:<index>`), so changing one outlet does not shift another's data. No dependency such as Faker is used.
- **Defaults:** seed `20261119`, two outlets, 60 days from `2026-02-01`, which covers Ramadan 2026 and Eid al-Fitr. The last 14 days are the held-out window (`heldOutFrom`), and `--days` must be at least 14.
- **Demand model:** base portions × outlet factor × weekday factor × calendar factor × multiplicative noise. Prep, sales and waste (kg, with a cause) follow from demand.
- **Calendar:** `src/calendar.ts` holds a fixed 2026–2027 Indonesian calendar (Ramadan, Eid, public holidays) with a demand factor per event. `get_calendar` can reuse it later.
- **Hidden spikes:** the generator adds demand spikes only on days with no calendar event, and always places some inside the held-out window. Their ground truth is returned in `dataset.spikes` for evals and is never written to the database.
- **Loading:** inserts run in one transaction, in batches of 1000. `--reset` truncates the mock-data tables (and the forecasts, recommendations and pickup requests that reference them) first, so re-running is idempotent. `emission_factors` and `agent_runs` are left alone. The CLI labels its output as `SIMULATED`.
- **Build:** unlike decision 0004, this package is not built. It is a dev tool run from source with `tsx`, `main` points at `src/index.ts`, and its `tsconfig.json` maps `@sisaku/db` to `../db/src/index.ts`, so `pnpm typecheck` passes before `@sisaku/db` is built.

## Consequences

- Tests and evals can use exact expected values for a given seed. Any change to the generator or calendar changes the data for every seed, so update the expected values in the same PR.
- The calendar is hand-maintained and may be off by a day against the official calendar. It needs new entries before 2028.
- Spike ground truth exists only in memory. An eval must call `generateMockData` with the same options as the seed run; it cannot read the spikes from Postgres.
- `--reset` deletes forecasts, recommendations and pickup requests. Never run it against a database with data that should be kept.
- The package uses `.js` import extensions and `tsx`, which differs from other packages. If it ever needs to ship, move it to the tsup build from 0004.
