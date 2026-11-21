import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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
  emission_factors: [
    {
      food_category: "rice",
      production_kg_co2e_per_kg: "4.45",
      landfill_kg_co2e_per_kg: "1.134",
      source: 'Our World in Data, "Rice"; IPCC',
    },
  ],
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
  it("rejects numerics that would overflow the column", () => {
    const m = (w: string) =>
      readCsv(
        "menu_items",
        serializeCsv("menu_items", [{ ...sample.menu_items[0]!, portion_weight_kg: w }]),
      );
    expect(m("123456.000").errors[0]!.message).toMatch(/more than 5 digits before/);
    expect(m("99999.999").errors).toEqual([]);
  });
  it("rejects a zero portion weight but accepts the smallest positive one", () => {
    const m = (w: string) =>
      readCsv(
        "menu_items",
        serializeCsv("menu_items", [{ ...sample.menu_items[0]!, portion_weight_kg: w }]),
      );
    expect(m("0.000").errors.map((e) => `${e.line}:${e.message}`)).toEqual([
      "2:portion_weight_kg: 0.000 must be greater than 0",
    ]);
    expect(m("0").errors[0]!.message).toMatch(/must be greater than 0/);
    expect(m("-0.1").errors[0]!.message).toMatch(/must be greater than 0/);
    expect(m("0.001").errors).toEqual([]);
  });
  it("rejects emission factors that are not positive, or a duplicate category", () => {
    const f = sample.emission_factors[0]!;
    const { errors } = readCsv(
      "emission_factors",
      serializeCsv("emission_factors", [
        f,
        { ...f, food_category: "beef", production_kg_co2e_per_kg: "0" },
        { ...f, food_category: "fish", landfill_kg_co2e_per_kg: "-1" },
        { ...f, source: "again" },
      ]),
    );
    expect(errors.map((e) => `${e.line}:${e.message}`)).toEqual([
      "3:production_kg_co2e_per_kg: 0 must be greater than 0",
      "4:landfill_kg_co2e_per_kg: -1 must be greater than 0",
      "5:duplicate key (food_category) already seen on line 2",
    ]);
  });
  it("the committed emission factor seed is valid and covers every mock-data food category", () => {
    const text = readFileSync(new URL("../seed/emission_factors.csv", import.meta.url), "utf8");
    const { rows, errors } = readCsv("emission_factors", text);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.food_category).sort()).toEqual([
      "beef",
      "chicken",
      "eggs",
      "fish",
      "fruit",
      "rice",
      "soy",
      "vegetables",
    ]);
    // Landfill factor (ADR 0011): DOC x DOCf x MCF x F x 16/12 x (1 - OX) x GWP100.
    const landfill = 0.15 * 0.7 * 0.6 * 0.5 * (16 / 12) * (1 - 0) * 27.0;
    for (const r of rows) {
      expect(Number(r.landfill_kg_co2e_per_kg)).toBeCloseTo(landfill, 6);
      expect(r.source).toMatch(/ourworldindata\.org/);
      expect(r.source).toMatch(/IPCC/);
    }
  });
  it("reports unterminated quotes", () => {
    expect(parseCsv('a,"b\n').error).toMatch(/unterminated/);
  });
});

const url = process.env.TEST_DATABASE_URL;
beforeAll(() => {
  if (!url) return;
  // Start from an empty schema: other test files share this database and leave rows behind,
  // and the assertions below count every row in `sales`.
  for (const d of ["reset", "up"])
    execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: url },
    });
});
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
    // A zero portion weight is rejected by the reader; nothing in the batch is written.
    const zero = await importCsv(db, {
      menu_items: serializeCsv("menu_items", [
        {
          ...sample.menu_items[0]!,
          id: "33333333-3333-4333-8333-333333333333",
          portion_weight_kg: "0.000",
        },
      ]),
    });
    expect(zero.ok).toBe(false);
    expect(zero.errors[0]).toMatchObject({
      file: "menu_items",
      line: 2,
      column: "portion_weight_kg",
    });
    expect((await pool.query("select count(*)::int as n from menu_items")).rows[0].n).toBe(1);
    const orphan = await importCsv(db, {
      sales: serializeCsv("sales", [{ ...sample.sales[0]!, item_id: O, date: "2026-11-02" }]),
    });
    expect(orphan.ok).toBe(false);
    expect(orphan.errors[0]).toMatchObject({ file: "sales", line: 2, column: "item_id" });
    // Item exists (in the DB) but belongs to a different outlet than the row's outlet_id.
    const O2 = "00000000-0000-4000-8000-0000000000b2";
    const mismatch = await importCsv(db, {
      outlets: serializeCsv("outlets", [{ ...sample.outlets[0]!, id: O2, name: "Other" }]),
      sales: serializeCsv("sales", [{ ...sample.sales[0]!, outlet_id: O2, date: "2026-11-03" }]),
      prep_logs: serializeCsv("prep_logs", [{ ...sample.prep_logs[0]!, outlet_id: O2 }]),
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.map((e) => `${e.file}:${e.line}:${e.column}`)).toEqual([
      "prep_logs:2:item_id",
      "sales:2:item_id",
    ]);
    expect(mismatch.errors[0]!.message).toMatch(/belongs to outlet/);
    // Moving an existing item to another outlet is rejected with a structured error, not a raw FK error.
    const rehome = await importCsv(db, {
      menu_items: serializeCsv("menu_items", [{ ...sample.menu_items[0]!, outlet_id: O2 }]),
    });
    expect(rehome.ok).toBe(false);
    expect(rehome.errors[0]).toMatchObject({ file: "menu_items", line: 2, column: "outlet_id" });
    // Emission factors upsert by food_category: re-importing with a new value updates the row.
    const factors = (v: string) => ({
      emission_factors: serializeCsv("emission_factors", [
        { ...sample.emission_factors[0]!, production_kg_co2e_per_kg: v },
      ]),
    });
    expect((await importCsv(db, factors("5"))).ok).toBe(true);
    const ef = await pool.query(
      "select food_category, production_kg_co2e_per_kg from emission_factors",
    );
    expect(ef.rows).toEqual([{ food_category: "rice", production_kg_co2e_per_kg: 5 }]);
  } finally {
    await pool.query("truncate prep_logs, sales, menu_items, outlets, emission_factors cascade");
    await pool.end();
  }
});
