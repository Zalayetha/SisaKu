import { inArray, sql } from "drizzle-orm";
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

const REFS: Record<string, { col: string; parent: "outlets" | "menu_items" }[]> = {
  menu_items: [{ col: "outlet_id", parent: "outlets" }],
  sales: [
    { col: "outlet_id", parent: "outlets" },
    { col: "item_id", parent: "menu_items" },
  ],
  prep_logs: [
    { col: "outlet_id", parent: "outlets" },
    { col: "item_id", parent: "menu_items" },
  ],
};

const chunks = <T>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Foreign keys must point at a row in this import or already in the database. */
async function checkReferences(
  db: NodePgDatabase<any>,
  parsed: [CsvTableName, CsvRow[]][],
  lineOf: Partial<Record<CsvTableName, number[]>>,
): Promise<ImportResult["errors"]> {
  const known: Partial<Record<CsvTableName, Set<string>>> = {};
  for (const [name, rows] of parsed) known[name] = new Set(rows.map((r) => r["id"] as string));
  const errors: ImportResult["errors"] = [];
  // item id -> owning outlet; rows in this import win over the database (they are upserted).
  const itemOutlet = new Map<string, string>();
  for (const [name, rows] of parsed)
    if (name === "menu_items")
      for (const r of rows) itemOutlet.set(r["id"] as string, r["outlet_id"] as string);
  for (const parent of ["outlets", "menu_items"] as const) {
    const wanted = new Set<string>();
    for (const [name, rows] of parsed)
      for (const ref of REFS[name] ?? [])
        if (ref.parent === parent)
          for (const r of rows) {
            const v = r[ref.col] as string;
            if (!known[parent]?.has(v)) wanted.add(v);
          }
    const found = new Set<string>();
    if (parent === "menu_items") {
      for (const chunk of chunks([...wanted], 1000))
        for (const row of await db
          .select({ id: menuItems.id, outletId: menuItems.outletId })
          .from(menuItems)
          .where(inArray(menuItems.id, chunk))) {
          found.add(row.id);
          itemOutlet.set(row.id, row.outletId);
        }
    } else {
      const t = outlets;
      for (const chunk of chunks([...wanted], 1000))
        for (const row of await db.select({ id: t.id }).from(t).where(inArray(t.id, chunk)))
          found.add(row.id);
    }
    for (const [name, rows] of parsed)
      for (const ref of REFS[name] ?? [])
        if (ref.parent === parent)
          rows.forEach((r, i) => {
            const v = r[ref.col] as string;
            if (!known[parent]?.has(v) && !found.has(v))
              errors.push({
                file: name,
                line: lineOf[name]![i]!,
                column: ref.col,
                message: `${ref.col}: no ${parent} row with id ${v} in the files or the database`,
              });
          });
  }
  // Re-homing an existing item is rejected (ADR 0008): rows that reference it keep the old outlet.
  const menuRows = parsed.find(([n]) => n === "menu_items")?.[1] ?? [];
  const current = new Map<string, string>();
  for (const chunk of chunks(
    menuRows.map((r) => r["id"] as string),
    1000,
  ))
    for (const row of await db
      .select({ id: menuItems.id, outletId: menuItems.outletId })
      .from(menuItems)
      .where(inArray(menuItems.id, chunk)))
      current.set(row.id, row.outletId);
  menuRows.forEach((r, i) => {
    const owner = current.get(r["id"] as string);
    if (owner !== undefined && owner !== r["outlet_id"])
      errors.push({
        file: "menu_items",
        line: lineOf["menu_items"]![i]!,
        column: "outlet_id",
        message: `outlet_id: item ${r["id"]} already belongs to outlet ${owner} and cannot move to outlet ${r["outlet_id"]}`,
      });
  });
  // An item must belong to the same outlet as the sales / prep row that uses it.
  for (const name of ["sales", "prep_logs"] as const)
    parsed
      .find(([n]) => n === name)?.[1]
      .forEach((r, i) => {
        const owner = itemOutlet.get(r["item_id"] as string);
        if (owner !== undefined && owner !== r["outlet_id"])
          errors.push({
            file: name,
            line: lineOf[name]![i]!,
            column: "item_id",
            message: `item_id: item ${r["item_id"]} belongs to outlet ${owner}, not outlet ${r["outlet_id"]}`,
          });
      });
  return errors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

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
  const lineOf: Partial<Record<CsvTableName, number[]>> = {};
  const errors: ImportResult["errors"] = [];
  for (const name of IMPORT_ORDER) {
    const text = files[name];
    if (text === undefined) continue;
    const r = readCsv(name, text);
    errors.push(...r.errors.map((e) => ({ ...e, file: name })));
    parsed.push([name, r.rows]);
    lineOf[name] = r.rowLines;
  }
  if (!errors.length) errors.push(...(await checkReferences(db, parsed, lineOf)));
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
