import { createDb, menuItems, outlets, prepLogs, sales, users, wasteEntries } from "@sisaku/db";
import { sql } from "drizzle-orm";
import type { MockDataset } from "./generate.js";

const BATCH = 1000;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/**
 * Loads a dataset into Postgres in one transaction.
 * `reset` truncates the mock-data tables (and anything referencing them) first, so re-running is idempotent.
 * Agent runs, and with them pipeline jobs and results, reference outlets and are emptied too (ADR
 * 0017); jobs of those runs still in Redis fail. Emission factors are left untouched.
 */
export async function loadDataset(data: MockDataset, opts: { url?: string; reset?: boolean } = {}) {
  const { db, pool } = createDb(opts.url);
  try {
    await db.transaction(async (tx) => {
      if (opts.reset) {
        await tx.execute(
          sql`truncate table waste_entries, prep_logs, sales, recommendations, forecasts, pickup_requests, menu_items, users, outlets cascade`,
        );
      }
      for (const [table, rows] of [
        [outlets, data.outlets],
        [users, data.users],
        [menuItems, data.menuItems],
        [sales, data.sales],
        [prepLogs, data.prepLogs],
        [wasteEntries, data.wasteEntries],
      ] as const) {
        for (const batch of chunks(rows as unknown[]))
          await tx.insert(table).values(batch as never);
      }
    });
  } finally {
    await pool.end();
  }
}
