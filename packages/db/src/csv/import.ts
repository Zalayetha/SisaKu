import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { menuItems, outlets, prepLogs, sales } from "../schema/index";
import { csvTables, readCsv, type CsvError, type CsvRow, type CsvTableName } from "./format";

const tables = { outlets, menu_items: menuItems, sales, prep_logs: prepLogs } as const;
/** Parents before children so foreign keys resolve. */
export const IMPORT_ORDER: readonly CsvTableName[] = [
  "outlets",
  "menu_items",
  "sales",
  "prep_logs",
];

const toRecord = (table: CsvTableName, row: CsvRow) =>
  Object.fromEntries(csvTables[table].columns.map((c) => [c.key, row[c.name]]));

export interface ImportResult {
  ok: boolean;
  inserted: Partial<Record<CsvTableName, number>>;
  errors: (CsvError & { file: CsvTableName })[];
}

/**
 * Import CSV files (keyed by table name) in one transaction. If any file has a bad row,
 * nothing is written and every error is returned. Existing rows with the same key are updated,
 * so re-importing the same files is safe.
 */
export async function importCsv(
  db: NodePgDatabase<any>,
  files: Partial<Record<CsvTableName, string>>,
): Promise<ImportResult> {
  const parsed: [CsvTableName, CsvRow[]][] = [];
  const errors: ImportResult["errors"] = [];
  for (const name of IMPORT_ORDER) {
    const text = files[name];
    if (text === undefined) continue;
    const r = readCsv(name, text);
    errors.push(...r.errors.map((e) => ({ ...e, file: name })));
    parsed.push([name, r.rows]);
  }
  if (errors.length) return { ok: false, inserted: {}, errors };
  const inserted: ImportResult["inserted"] = {};
  await db.transaction(async (tx) => {
    for (const [name, rows] of parsed) {
      const t = tables[name] as any;
      const cols = csvTables[name].columns;
      const keys =
        name === "sales" || name === "prep_logs" ? ["outletId", "itemId", "date"] : ["id"];
      const update = Object.fromEntries(
        cols
          .filter((c) => !keys.includes(c.key))
          .map((c) => [c.key, sql.raw(`excluded."${c.name}"`)]),
      );
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000).map((r) => toRecord(name, r));
        await tx
          .insert(t)
          .values(chunk)
          .onConflictDoUpdate({ target: keys.map((k) => t[k]), set: update });
      }
      inserted[name] = rows.length;
    }
  });
  return { ok: true, inserted, errors: [] };
}
