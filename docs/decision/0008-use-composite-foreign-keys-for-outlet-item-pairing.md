# 0008: Enforce outlet and item pairing with composite foreign keys

- Date: 2026-11-20
- Status: accepted

## Context

`sales`, `prep_logs`, `waste_entries` and `forecasts` each have `outlet_id` and `item_id` as independent foreign keys. Nothing tied them together, so a row for outlet B could point at an item from outlet A's menu and still be valid. Per-outlet reads such as `get_sales(outlet)` would return items that are not on that outlet's menu, and forecasts could train on them. The CSV importer already rejects such rows (ADR 0007), but other writers (the `kitchen-mcp` tools, the nightly pipeline) would only have application-level checks.

## Decision

- `menu_items` gets a unique constraint on `(id, outlet_id)`. It is redundant with the primary key on `id`, but a composite foreign key needs a matching unique target.
- On `sales`, `prep_logs`, `waste_entries` and `forecasts`, the separate `outlet_id -> outlets` and `item_id -> menu_items` foreign keys are replaced by one composite key `(item_id, outlet_id) -> menu_items (id, outlet_id)`, named `<table>_item_outlet_fk`. Outlet existence is still guaranteed, through `menu_items.outlet_id`.
- Shipped as migration `0001_composite_item_outlet_fk` with a hand-written down file. `0000` is untouched. Other tables with `outlet_id` (`users`, `pickup_requests`) have no `item_id`, so nothing changes there. `recommendations` reaches an item only through `forecast_id`.
- The up migration first checks for existing rows that pair an item with another outlet and fails with the offending row counts per table, instead of a bare foreign-key error. It does not delete or repair data.
- `scripts/migrate.ts` now has `down` (`pnpm db:rollback`, revert the latest migration only) and `reset` (`pnpm db:reset`, revert everything, empty database). `reset`, and `down` when only `0000` is applied, keep the `_test` database-name guard. This delivers the per-migration rollback that ADR 0005 listed as follow-up.

## Consequences

- Writers must supply the outlet that owns the item. The mock-data generator and CSV importer already do. Checked by seeding 2 outlets, 60 days (1080 sales, 1080 prep logs, 813 waste entries): migration up, down and up again all pass with zero violating rows. `kitchen-mcp` is still a placeholder, so `log_waste` and `update_entry` (ZALS-13) must resolve the item within the caller's outlet; a mismatch now surfaces as a Postgres foreign-key error to translate into a tool error.
- Deleting or re-homing a menu item to another outlet is blocked while rows reference it (no cascade, as before).
- `test/composite-fk.test.ts` covers each affected table, rollback and the violation message. It needs `TEST_DATABASE_URL`, like `schema.test.ts`.
