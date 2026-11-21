/**
 * CSV format shared by the mock data generator and the importer.
 *
 * One file per table; the header is the table's snake_case column names, in the order below.
 * Files: outlets.csv, menu_items.csv, sales.csv, prep_logs.csv, emission_factors.csv. RFC 4180 quoting, UTF-8,
 * comma separated, a header row is required, empty cell = NULL (only where nullable).
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Kind = "uuid" | "text" | "date" | "int" | "numeric";
export interface Column {
  /** snake_case CSV header / DB column */
  name: string;
  /** camelCase property of the Drizzle table */
  key: string;
  kind: Kind;
  nullable?: boolean;
  /** numeric: max fractional digits */
  scale?: number;
  /** numeric: max total digits (matches the Postgres column), so overflow is caught per line */
  precision?: number;
  /** int/numeric: minimum allowed value */
  min?: number;
  /** numeric: the minimum itself is not allowed (value must be greater than min) */
  minExclusive?: boolean;
}

export const csvTables = {
  outlets: {
    key: ["id"],
    columns: [
      { name: "id", key: "id", kind: "uuid" },
      { name: "name", key: "name", kind: "text" },
      { name: "location", key: "location", kind: "text", nullable: true },
      { name: "timezone", key: "timezone", kind: "text" },
    ],
  },
  menu_items: {
    key: ["id"],
    columns: [
      { name: "id", key: "id", kind: "uuid" },
      { name: "outlet_id", key: "outletId", kind: "uuid" },
      { name: "name", key: "name", kind: "text" },
      { name: "category", key: "category", kind: "text" },
      {
        name: "cost_per_portion",
        key: "costPerPortion",
        kind: "numeric",
        precision: 12,
        scale: 2,
        min: 0,
      },
      {
        name: "portion_weight_kg",
        key: "portionWeightKg",
        kind: "numeric",
        precision: 8,
        scale: 3,
        min: 0,
        minExclusive: true, // a 0 kg portion cannot convert portions to kg
      },
      { name: "food_category", key: "foodCategory", kind: "text" },
    ],
  },
  sales: {
    key: ["outlet_id", "item_id", "date"],
    columns: [
      { name: "outlet_id", key: "outletId", kind: "uuid" },
      { name: "item_id", key: "itemId", kind: "uuid" },
      { name: "date", key: "date", kind: "date" },
      { name: "qty_sold", key: "qtySold", kind: "int", min: 0 },
    ],
  },
  prep_logs: {
    key: ["outlet_id", "item_id", "date"],
    columns: [
      { name: "outlet_id", key: "outletId", kind: "uuid" },
      { name: "item_id", key: "itemId", kind: "uuid" },
      { name: "date", key: "date", kind: "date" },
      { name: "qty_prepped", key: "qtyPrepped", kind: "int", min: 0 },
    ],
  },
  // kg CO2e per kg of food waste, one row per menu_items.food_category (ZALS-14, ADR 0011).
  emission_factors: {
    key: ["food_category"],
    columns: [
      { name: "food_category", key: "foodCategory", kind: "text" },
      {
        name: "production_kg_co2e_per_kg",
        key: "productionKgCo2ePerKg",
        kind: "numeric",
        scale: 6,
        min: 0,
        minExclusive: true,
      },
      {
        name: "landfill_kg_co2e_per_kg",
        key: "landfillKgCo2ePerKg",
        kind: "numeric",
        scale: 6,
        min: 0,
        minExclusive: true,
      },
      { name: "source", key: "source", kind: "text" },
    ],
  },
} as const satisfies Record<string, { key: readonly string[]; columns: readonly Column[] }>;

export type CsvTableName = keyof typeof csvTables;
export type CsvRow = Record<string, string | number | null>;
export interface CsvError {
  /** 1-based line number in the file (header is line 1); 0 for file-level errors */
  line: number;
  column?: string;
  message: string;
}

/** Split RFC 4180 text into records. Returns an error for an unterminated quote. */
export function parseCsv(text: string): { records: string[][]; lines: number[]; error?: string } {
  const records: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") {
      records.push(row);
      lines.push(start);
    }
    row = [];
    cell = "";
    any = false;
  };
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"' && !any && cell === "") {
      quoted = true;
      any = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      any = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
      line++;
      start = line;
    } else {
      cell += c;
      any = true;
    }
  }
  if (quoted) return { records, lines, error: `unterminated quote starting near line ${start}` };
  if (cell !== "" || row.length) endRow();
  return { records, lines };
}

const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Serialize rows (keyed by CSV column name) to CSV text with a header row. */
export function serializeCsv(table: CsvTableName, rows: readonly CsvRow[]): string {
  const cols = csvTables[table].columns;
  const out = [cols.map((c) => c.name).join(",")];
  for (const r of rows)
    out.push(cols.map((c) => (r[c.name] == null ? "" : q(String(r[c.name])))).join(","));
  return out.join("\n") + "\n";
}

function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseCell(
  col: Column,
  raw: string,
): { value: string | number | null } | { error: string } {
  if (raw === "") {
    return col.nullable ? { value: null } : { error: "must not be empty" };
  }
  switch (col.kind) {
    case "uuid":
      return UUID.test(raw)
        ? { value: raw.toLowerCase() }
        : { error: `"${raw}" is not a valid UUID` };
    case "text":
      return { value: raw };
    case "date":
      return validDate(raw)
        ? { value: raw }
        : { error: `"${raw}" is not a valid date (YYYY-MM-DD)` };
    case "int": {
      if (!/^-?\d+$/.test(raw)) return { error: `"${raw}" is not an integer` };
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n > 2147483647) return { error: `"${raw}" is out of range` };
      return col.min !== undefined && n < col.min
        ? { error: `${raw} is below the minimum ${col.min}` }
        : { value: n };
    }
    case "numeric": {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return { error: `"${raw}" is not a number` };
      const frac = raw.split(".")[1]?.length ?? 0;
      if (col.scale !== undefined && frac > col.scale)
        return { error: `"${raw}" has more than ${col.scale} decimal places` };
      if (col.precision !== undefined) {
        const maxInt = col.precision - (col.scale ?? 0);
        const intDigits = raw
          .replace(/^-/, "")
          .split(".")[0]!
          .replace(/^0+(?=\d)/, "").length;
        if (intDigits > maxInt)
          return { error: `"${raw}" has more than ${maxInt} digits before the decimal point` };
      }
      if (col.min !== undefined && col.minExclusive && Number(raw) <= col.min)
        return { error: `${raw} must be greater than ${col.min}` };
      return col.min !== undefined && Number(raw) < col.min
        ? { error: `${raw} is below the minimum ${col.min}` }
        : { value: raw };
    }
  }
}

/**
 * Parse and validate CSV text for a table. Never throws on bad data: every problem is
 * reported in `errors` with its line number, and `rows` only holds rows that passed.
 * Rows are keyed by CSV column name.
 */
export function readCsv(table: CsvTableName, text: string) {
  const cols = csvTables[table].columns as readonly Column[];
  const errors: CsvError[] = [];
  const rows: CsvRow[] = [];
  /** line number of each entry in `rows` */
  const rowLines: number[] = [];
  const { records, lines, error } = parseCsv(text);
  if (error) errors.push({ line: 0, message: error });
  if (records.length === 0) {
    errors.push({ line: 0, message: "file is empty: header row required" });
    return { rows, rowLines, errors };
  }
  const header = records[0]!.map((h) => h.trim());
  const expected = cols.map((c) => c.name);
  if (header.join(",") !== expected.join(",")) {
    errors.push({
      line: 1,
      message: `header must be exactly: ${expected.join(",")} (got: ${header.join(",")})`,
    });
    return { rows, rowLines, errors };
  }
  const seen = new Map<string, number>();
  const pk = csvTables[table].key;
  for (let i = 1; i < records.length; i++) {
    const rec = records[i]!;
    const line = lines[i]!;
    if (rec.length !== cols.length) {
      errors.push({ line, message: `expected ${cols.length} columns, got ${rec.length}` });
      continue;
    }
    const row: CsvRow = {};
    let ok = true;
    cols.forEach((col, j) => {
      const r = parseCell(col, rec[j]!);
      if ("error" in r) {
        ok = false;
        errors.push({ line, column: col.name, message: `${col.name}: ${r.error}` });
      } else row[col.name] = r.value;
    });
    if (!ok) continue;
    const key = pk.map((k) => row[k]).join("|");
    const prev = seen.get(key);
    if (prev !== undefined) {
      errors.push({
        line,
        message: `duplicate key (${pk.join(", ")}) already seen on line ${prev}`,
      });
      continue;
    }
    seen.set(key, line);
    rows.push(row);
    rowLines.push(line);
  }
  return { rows, rowLines, errors };
}

export const formatErrors = (file: string, errors: readonly CsvError[]) =>
  errors.map((e) => `${file}:${e.line || "-"}: ${e.message}`);
