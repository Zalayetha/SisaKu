import { describe, expect, it } from "vitest";
import {
  csvTables,
  parseCsv,
  readCsv,
  serializeCsv,
  type CsvRow,
  type CsvTableName,
} from "../src/csv/format";
import { importCsv } from "../src/csv/import";
import { createDb } from "../src/client";

const O = "11111111-1111-4111-8111-111111111111";
const I = "22222222-2222-4222-8222-222222222222";
const sample: Record<CsvTableName, CsvRow[]> = {
  outlets: [{ id: O, name: 'Warung "Rina", Jaksel', location: null, timezone: "Asia/Jakarta" }],
  menu_items: [
    {
      id: I,
      outlet_id: O,
      name: "Nasi\ngoreng",
      category: "main",
      cost_per_portion: "12000.00",
      portion_weight_kg: "0.350",
      food_category: "rice",
    },
  ],
  sales: [{ outlet_id: O, item_id: I, date: "2026-11-01", qty_sold: 42 }],
  prep_logs: [{ outlet_id: O, item_id: I, date: "2026-11-01", qty_prepped: 50 }],
};

describe("csv round trip", () => {
  for (const t of Object.keys(csvTables) as CsvTableName[]) {
    it(`${t}: serialize then read gives identical rows`, () => {
      const r = readCsv(t, serializeCsv(t, sample[t]));
      expect(r.errors).toEqual([]);
      expect(r.rows).toEqual(sample[t]);
    });
  }
  it("handles CRLF and BOM", () => {
    const text = "﻿" + serializeCsv("sales", sample.sales).replace(/\n/g, "\r\n");
    expect(readCsv("sales", text).rows).toEqual(sample.sales);
  });
});

describe("csv validation", () => {
  const h = "outlet_id,item_id,date,qty_sold\n";
  it("rejects bad rows with line numbers and clear messages", () => {
    const text =
      h +
      `${O},${I},2026-11-01,5\n` +
      `nope,${I},2026-02-30,-3\n` +
      `${O},${I},2026-11-01,6\n` +
      `${O},${I},2026-11-02\n` +
      `${O},${I},2026-11-03,1.5\n`;
    const { rows, errors } = readCsv("sales", text);
    expect(rows).toHaveLength(1);
    const msgs = errors.map((e) => `${e.line}:${e.message}`);
    expect(msgs).toContain('3:outlet_id: "nope" is not a valid UUID');
    expect(msgs).toContain('3:date: "2026-02-30" is not a valid date (YYYY-MM-DD)');
    expect(msgs).toContain("3:qty_sold: -3 is below the minimum 0");
    expect(msgs).toContain("4:duplicate key (outlet_id, item_id, date) already seen on line 2");
    expect(msgs).toContain("5:expected 4 columns, got 3");
    expect(msgs).toContain('6:qty_sold: "1.5" is not an integer');
  });
  it("rejects wrong header, empty file, empty required cell, too many decimals", () => {
    expect(readCsv("sales", "a,b\n1,2\n").errors[0]!.message).toMatch(/header must be exactly/);
    expect(readCsv("sales", "").errors[0]!.message).toMatch(/file is empty/);
    expect(readCsv("outlets", `id,name,location,timezone\n${O},,,UTC\n`).errors[0]!.message).toBe(
      "name: must not be empty",
    );
    const m = serializeCsv("menu_items", [
      { ...sample.menu_items[0]!, portion_weight_kg: "0.3501" },
    ]);
    expect(readCsv("menu_items", m).errors[0]!.message).toMatch(/more than 3 decimal places/);
  });
  it("reports unterminated quotes", () => {
    expect(parseCsv('a,"b\n').error).toMatch(/unterminated/);
  });
});

const url = process.env.TEST_DATABASE_URL;
it.skipIf(!url)("imports into Postgres and is idempotent; bad file writes nothing", async () => {
  const { db, pool } = createDb(url);
  try {
    const files = Object.fromEntries(
      (Object.keys(sample) as CsvTableName[]).map((t) => [t, serializeCsv(t, sample[t])]),
    );
    expect((await importCsv(db, files)).ok).toBe(true);
    expect((await importCsv(db, files)).ok).toBe(true);
    const r = await pool.query("select qty_sold from sales");
    expect(r.rows).toEqual([{ qty_sold: 42 }]);
    const bad = await importCsv(db, { sales: "outlet_id,item_id,date,qty_sold\nx,y,z,w\n" });
    expect(bad.ok).toBe(false);
  } finally {
    await pool.query("truncate prep_logs, sales, menu_items, outlets cascade");
    await pool.end();
  }
});
