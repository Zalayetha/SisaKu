# 0005: Use Drizzle for the Postgres schema, with hand-written down migrations

- Date: 2026-11-19
- Status: accepted

## Context

SisaKu stores relational data in PostgreSQL (11 tables from `technical-design.md`). Agents never touch the database directly; the MCP servers do. Migrations must apply cleanly on an empty database and be reversible. RAG chunks live in Qdrant, so there is no `knowledge_chunks` table and no pgvector.

## Decision

- **Package:** `packages/db` (`@sisaku/db`) holds the schema (`src/schema/index.ts`), client (`src/client.ts`), `drizzle.config.ts` and migrations in `drizzle/`.
- **Tables:** `outlets`, `users`, `menu_items`, `sales`, `prep_logs`, `waste_entries`, `forecasts`, `recommendations`, `pickup_requests`, `emission_factors`, `agent_runs`.
- **Units and enums:** waste is stored in kg (`waste_entries.weight_kg`). `users.role` is the enum `staff | manager | owner`. Status columns for recommendations, pickups and agent runs are enums too.
- **Baseline:** the forecast baseline lives only on `forecasts`. `recommendations` read it through `forecast_id`.
- **Pickup requests:** `status` includes `draft` and `submitted` besides pending/approved/rejected, so nothing is submitted without approval. `foodbank_id` is text because the food bank list is mock data in `impact-mcp`.
- **Reversibility:** `drizzle-kit generate` makes the up migration. Down migrations are written by hand in `drizzle/down/`. `pnpm db:rollback` reverts the latest migration only (since 0001; see 0008). `pnpm db:reset` reverts all of them to an empty database. Both refuse a database whose name does not end in `_test` when that would drop every table (unless `ALLOW_DESTRUCTIVE_DB=1`).
- **Scripts:** `db:generate`, `db:migrate`, `db:rollback`, `db:push`, `db:studio`.

## Consequences

- The migration test (`test/schema.test.ts`, run by the root `pnpm test`) applies migrations, checks the tables and role enum, rolls back to empty and re-applies. It skips when `TEST_DATABASE_URL` is unset, so CI needs a Postgres service and `TEST_DATABASE_URL` pointing at a database whose name ends in `_test`, because `db:rollback` refuses any other name.
- Down files are not generated and can drift from the schema. Review them in every migration PR.
- Changing a status enum needs a migration that alters the Postgres enum type.
