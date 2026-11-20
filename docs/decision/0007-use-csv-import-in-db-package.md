# 0007: Import sales, prep logs and menu from CSV through `@sisaku/db`

- Date: 2026-11-20
- Status: accepted

## Context

Outlets need to load sales, prep logs and menu data from files, in the same format the mock-data generator produces. Bad data must be rejected with messages a person can act on, and a failed import must not leave half the data in Postgres.

## Decision

- **Location:** `packages/db/src/csv/`. `format.ts` holds the format, parser, serializer and validation; `import.ts` holds `importCsv`. Both are exported from `@sisaku/db`, so the generator and the importer share one format.
- **Format:** one file per table: `outlets.csv`, `menu_items.csv`, `sales.csv`, `prep_logs.csv`. UTF-8, comma separated, RFC 4180 quoting, a required header row with the table's snake_case column names in schema order. An empty cell is NULL, allowed only for nullable columns.
- **Validation:** every cell is checked by type (uuid, date, int, numeric with a maximum scale, minimum value). Errors carry file, line (header is line 1), column and a message. Wrong header, wrong column count, unterminated quotes and duplicate keys within a file are also reported. All errors are collected, not just the first.
- **Writing:** `importCsv` writes in one transaction, parents before children (outlets, menu_items, sales, prep_logs). If any file has an error, nothing is written and all errors are returned. Rows are inserted in batches of 1000 with upsert on the primary key (`id`, or `outlet_id, item_id, date`), so re-importing the same files is safe.
- **Entry point:** a CLI, `pnpm --filter @sisaku/db db:import-csv <dir>`, which reads the `<table>.csv` files present in the directory, prints errors as `file.csv:line: message`, and exits with code 1 on rejection. We chose a CLI over a Hono endpoint because the import is an operator task and needs no auth or upload handling.
- **Tests:** `packages/db/test/csv.test.ts` covers the round trip (serialize, read, identical rows) and the rejection cases.

## Consequences

- Changing a table's columns means updating `csvTables` in `format.ts` in the same PR, or the importer and generator drift apart.
- Upsert means an import can overwrite existing rows with the same key. It never deletes rows missing from the file.
- Foreign keys are checked by Postgres, not the parser, so a `sales` row that points at an unknown item fails the whole transaction with a database error, not a line-numbered message.
- A Hono upload endpoint can be added later on top of `importCsv` without changing the format.
