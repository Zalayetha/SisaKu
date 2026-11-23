import { agentRuns, menuItems, wasteEntries } from "@sisaku/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getMenu,
  getPrepLog,
  getSales,
  KitchenError,
  logWaste,
  queryWaste,
  updateEntry,
  type Db,
} from "./kitchen";
import type { LogWasteInput } from "./schemas";
import { ids, setupTestDb, testDbUrl, unknownId } from "./test-fixture";

type TestPool = Awaited<ReturnType<typeof setupTestDb>>["pool"];

/** A one-line log_waste call, as most tests need; returns that line's entry. */
async function logOne(
  db: Db,
  input: Omit<LogWasteInput, "lines"> &
    ({ item_id: string; portion_count: number } | { item_id: string; weight_kg: number }),
) {
  const { item_id, ...rest } = input;
  const amount =
    "portion_count" in rest ? { portion_count: rest.portion_count } : { weight_kg: rest.weight_kg };
  const shared = Object.fromEntries(
    Object.entries(rest).filter(([k]) => k !== "portion_count" && k !== "weight_kg"),
  ) as Omit<LogWasteInput, "lines">;
  const { entries } = await logWaste(db, { ...shared, lines: [{ item_id, ...amount }] });
  return { entry: entries[0]! };
}

// Unit tests of each tool's logic against Postgres. Input validation (bad ids, ranges, exactly-one
// rules, photo paths) is enforced by the schemas and tested through the MCP client in server.test.ts.
describe.skipIf(!testDbUrl)("kitchen tools", () => {
  let db: Db;
  let pool: TestPool;
  const A = ids.outletA;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
  });
  afterAll(async () => {
    await pool?.end();
  });

  const rejects = (p: Promise<unknown>, msg: RegExp) =>
    expect(p).rejects.toSatisfy((e) => e instanceof KitchenError && msg.test(e.message));

  describe("get_sales", () => {
    it("returns rows for the inclusive range, ordered by date then item name", async () => {
      const r = await getSales(db, { outlet_id: A, from: "2026-03-01", to: "2026-03-02" });
      expect(r.rows).toEqual([
        { date: "2026-03-01", item_id: ids.nasi, item_name: "Nasi Putih", qty_sold: 101 },
        { date: "2026-03-01", item_id: ids.rendang, item_name: "Rendang Sapi", qty_sold: 41 },
        { date: "2026-03-02", item_id: ids.nasi, item_name: "Nasi Putih", qty_sold: 102 },
        { date: "2026-03-02", item_id: ids.rendang, item_name: "Rendang Sapi", qty_sold: 42 },
      ]);
    });

    it("filters by item and never returns another outlet's sales", async () => {
      const r = await getSales(db, {
        outlet_id: A,
        from: "2026-03-01",
        to: "2026-03-31",
        item_id: ids.rendang,
      });
      expect(r.rows.map((x) => x.qty_sold)).toEqual([41, 42, 43]);
    });

    it("rejects an unknown outlet, another outlet's item and ranges over 92 days", async () => {
      await rejects(
        getSales(db, { outlet_id: unknownId, from: "2026-03-01", to: "2026-03-02" }),
        /Unknown outlet/,
      );
      await rejects(
        getSales(db, { outlet_id: A, from: "2026-03-01", to: "2026-03-02", item_id: ids.soto }),
        /not on the menu/,
      );
      await expect(
        getSales(db, { outlet_id: A, from: "2026-01-01", to: "2026-04-02" }), // 92 days
      ).resolves.toBeTruthy();
      await rejects(
        getSales(db, { outlet_id: A, from: "2026-01-01", to: "2026-04-03" }),
        /93 days/,
      );
    });
  });

  describe("get_menu", () => {
    it("returns the outlet's items with numeric cost and weight", async () => {
      const r = await getMenu(db, { outlet_id: A });
      expect(r.items).toEqual([
        {
          id: ids.nasi,
          name: "Nasi Putih",
          category: "main",
          cost_per_portion: 2500,
          portion_weight_kg: 0.2,
          food_category: "rice",
        },
        {
          id: ids.rendang,
          name: "Rendang Sapi",
          category: "main",
          cost_per_portion: 13000,
          portion_weight_kg: 0.12,
          food_category: "rice",
        },
      ]);
    });

    it("rejects an unknown outlet", async () => {
      await rejects(getMenu(db, { outlet_id: unknownId }), /Unknown outlet/);
    });
  });

  describe("get_prep_log", () => {
    it("returns one day's prep, and nothing for a day without a log", async () => {
      const r = await getPrepLog(db, { outlet_id: A, date: "2026-03-01" });
      expect(r.rows).toEqual([
        { item_id: ids.nasi, item_name: "Nasi Putih", qty_prepped: 120 },
        { item_id: ids.rendang, item_name: "Rendang Sapi", qty_prepped: 50 },
      ]);
      expect((await getPrepLog(db, { outlet_id: A, date: "2026-03-02" })).rows).toEqual([]);
    });

    it("rejects an unknown outlet", async () => {
      await rejects(getPrepLog(db, { outlet_id: unknownId, date: "2026-03-01" }), /Unknown outlet/);
    });
  });

  describe("query_waste", () => {
    const filters = { outlet_id: A, from: "2026-03-01", to: "2026-03-02" };

    it("groups by the outlet's local day, not the UTC day", async () => {
      const r = await queryWaste(db, { filters, group_by: "day" });
      expect(r.timezone).toBe("Asia/Jakarta");
      // The nasi entry is 18:00 UTC on 03-01, which is 01:00 on 03-02 in Jakarta.
      expect(r.groups.map((g) => [g.date, g.waste_kg, g.entries])).toEqual([
        ["2026-03-01", 0.36, 1],
        ["2026-03-02", 1.24, 2],
      ]);
      const day1 = await queryWaste(db, {
        filters: { ...filters, to: "2026-03-01" },
        group_by: "none",
      });
      expect(day1.groups).toEqual([{ waste_kg: 0.36, entries: 1, portions: 3, cost_idr: 39000 }]);
    });

    it("groups by item with estimated portions and Rupiah, heaviest first", async () => {
      const r = await queryWaste(db, { filters, group_by: "item" });
      expect(r.groups).toEqual([
        {
          item_id: ids.nasi,
          item_name: "Nasi Putih",
          waste_kg: 1,
          entries: 1,
          portions: 5,
          cost_idr: 12500,
        },
        {
          item_id: ids.rendang,
          item_name: "Rendang Sapi",
          waste_kg: 0.6,
          entries: 2,
          portions: 5,
          cost_idr: 65000,
        },
      ]);
    });

    it("groups by cause and applies item and cause filters", async () => {
      const byCause = await queryWaste(db, { filters, group_by: "cause" });
      expect(byCause.groups.map((g) => [g.cause, g.waste_kg])).toEqual([
        ["spoilage", 1],
        ["over_prep", 0.36],
        ["plate_waste", 0.24],
      ]);
      const rendang = await queryWaste(db, {
        filters: { ...filters, item_id: ids.rendang, cause: "plate_waste" },
        group_by: "none",
      });
      expect(rendang.groups).toEqual([
        { waste_kg: 0.24, entries: 1, portions: 2, cost_idr: 26000 },
      ]);
    });

    it("returns no groups for a range without waste, and never another outlet's waste", async () => {
      const empty = await queryWaste(db, {
        filters: { outlet_id: A, from: "2026-02-01", to: "2026-02-28" },
        group_by: "none",
      });
      expect(empty.groups).toEqual([]);
      const b = await queryWaste(db, {
        filters: { ...filters, outlet_id: ids.outletB },
        group_by: "item",
      });
      expect(b.groups.map((g) => g.item_name)).toEqual(["Soto Ayam"]);
    });

    it("rejects an unknown outlet and another outlet's item", async () => {
      await rejects(
        queryWaste(db, { filters: { ...filters, outlet_id: unknownId }, group_by: "none" }),
        /Unknown outlet/,
      );
      await rejects(
        queryWaste(db, { filters: { ...filters, item_id: ids.soto }, group_by: "none" }),
        /not on the menu/,
      );
    });
  });

  describe("log_waste", () => {
    const base = { outlet_id: A, cause: "over_prep", source: "text" } as const;

    it("converts portions to kg with the item's portion weight", async () => {
      const { entry } = await logOne(db, { ...base, item_id: ids.rendang, portion_count: 4 });
      expect(entry).toMatchObject({
        outlet_id: A,
        item_id: ids.rendang,
        item_name: "Rendang Sapi",
        weight_kg: 0.48,
        portion_count: 4,
        cause: "over_prep",
        source: "text",
        photo_path: null,
      });
      expect(Math.abs(Date.parse(entry.logged_at) - Date.now())).toBeLessThan(60_000);
    });

    it("stores a typed weight rounded to grams, plus photo, confidence, confirmer and time", async () => {
      const { entry } = await logOne(db, {
        ...base,
        source: "photo",
        item_id: ids.nasi,
        weight_kg: 1.23456,
        photo_path: `${A}/photo-1.jpg`,
        confidence: 0.82,
        confirmed_by: ids.staffA,
        logged_at: "2026-03-05T20:30:00+07:00",
      });
      expect(entry).toMatchObject({
        weight_kg: 1.235,
        portion_count: null,
        source: "photo",
        photo_path: `${A}/photo-1.jpg`,
        confidence: 0.82,
        confirmed_by: ids.staffA,
        logged_at: "2026-03-05T13:30:00.000Z",
      });
    });

    it("saves every line in one transaction, or none when any line is rejected", async () => {
      const count = async () =>
        Number((await db.execute(sql`select count(*) from waste_entries`)).rows[0]!.count);
      const before = await count();
      const { entries } = await logWaste(db, {
        ...base,
        lines: [
          { item_id: ids.nasi, portion_count: 2 },
          { item_id: ids.rendang, weight_kg: 0.5 },
        ],
      });
      expect(entries.map((e) => [e.item_name, e.weight_kg, e.portion_count])).toEqual([
        ["Nasi Putih", 0.4, 2],
        ["Rendang Sapi", 0.5, null],
      ]);
      await rejects(
        logWaste(db, {
          ...base,
          lines: [
            { item_id: ids.nasi, portion_count: 1 },
            { item_id: ids.soto, portion_count: 1 },
          ],
        }),
        /not on the menu/,
      );
      expect(await count()).toBe(before + 2);
    });

    it("links the entry to the agent run that logged it, and rejects an unknown run", async () => {
      const [run] = await db
        .insert(agentRuns)
        .values({ agent: "copilot", trigger: "telegram", traceId: "trace-1" })
        .returning({ id: agentRuns.id });
      const { entry } = await logOne(db, {
        ...base,
        item_id: ids.nasi,
        portion_count: 1,
        run_id: run!.id,
      });
      expect(entry.run_id).toBe(run!.id);
      await rejects(
        logOne(db, { ...base, item_id: ids.nasi, portion_count: 1, run_id: unknownId }),
        /Unknown agent run/,
      );
    });

    it("rejects another outlet's item or user, an unknown outlet and a future time", async () => {
      await rejects(
        logOne(db, { ...base, item_id: ids.soto, portion_count: 1 }),
        /not on the menu/,
      );
      await rejects(
        logOne(db, { ...base, item_id: ids.nasi, portion_count: 1, confirmed_by: ids.staffB }),
        /does not belong to outlet/,
      );
      await rejects(
        logOne(db, { ...base, outlet_id: unknownId, item_id: ids.nasi, portion_count: 1 }),
        /Unknown outlet/,
      );
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await rejects(
        logOne(db, { ...base, item_id: ids.nasi, portion_count: 1, logged_at: future }),
        /in the future/,
      );
    });
  });

  describe("update_entry", () => {
    const create = async (input: { portion_count: number } | { weight_kg: number }) =>
      (
        await logOne(db, {
          outlet_id: A,
          item_id: ids.rendang,
          cause: "over_prep",
          source: "text",
          ...input,
        })
      ).entry;

    it("recalculates kg when the portion count changes and returns before and after", async () => {
      const e = await create({ portion_count: 2 });
      const r = await updateEntry(db, { outlet_id: A, id: e.id, patch: { portion_count: 5 } });
      expect(r.before).toMatchObject({ portion_count: 2, weight_kg: 0.24 });
      expect(r.after).toMatchObject({ portion_count: 5, weight_kg: 0.6, cause: "over_prep" });
    });

    it("recalculates kg with the new item's portion weight when the item changes", async () => {
      const e = await create({ portion_count: 2 });
      const r = await updateEntry(db, {
        outlet_id: A,
        id: e.id,
        patch: { item_id: ids.nasi, cause: "spoilage" },
      });
      expect(r.after).toMatchObject({
        item_id: ids.nasi,
        item_name: "Nasi Putih",
        portion_count: 2,
        weight_kg: 0.4,
        cause: "spoilage",
      });
    });

    it("keeps a typed weight when only the item changes, and clears portions when a weight is typed", async () => {
      const typed = await create({ weight_kg: 0.5 });
      const moved = await updateEntry(db, {
        outlet_id: A,
        id: typed.id,
        patch: { item_id: ids.nasi },
      });
      expect(moved.after).toMatchObject({ item_id: ids.nasi, weight_kg: 0.5, portion_count: null });

      const counted = await create({ portion_count: 3 });
      const weighed = await updateEntry(db, {
        outlet_id: A,
        id: counted.id,
        patch: { weight_kg: 0.75 },
      });
      expect(weighed.after).toMatchObject({ weight_kg: 0.75, portion_count: null });
    });

    it("changes logged_at", async () => {
      const e = await create({ portion_count: 1 });
      const r = await updateEntry(db, {
        outlet_id: A,
        id: e.id,
        patch: { logged_at: "2026-03-04T09:00:00+07:00" },
      });
      expect(r.after.logged_at).toBe("2026-03-04T02:00:00.000Z");
    });

    it("rejects another outlet's entry, another outlet's item, and a future time", async () => {
      await rejects(
        updateEntry(db, { outlet_id: A, id: ids.wasteSotoB, patch: { cause: "expired" } }),
        /not found for outlet/,
      );
      await rejects(
        updateEntry(db, { outlet_id: A, id: unknownId, patch: { cause: "expired" } }),
        /not found for outlet/,
      );
      const e = await create({ portion_count: 1 });
      await rejects(
        updateEntry(db, { outlet_id: A, id: e.id, patch: { item_id: ids.soto } }),
        /not on the menu/,
      );
      await rejects(
        updateEntry(db, {
          outlet_id: A,
          id: e.id,
          patch: { logged_at: new Date(Date.now() + 3_600_000).toISOString() },
        }),
        /in the future/,
      );
    });
  });

  // Migration 0002 forbids a 0 portion weight; kitchen-mcp still guards against it for a database
  // that has not been migrated yet. Drop the check to simulate one, and restore it afterwards.
  describe("an item with a 0 portion weight (database without the check)", () => {
    const kerupuk = "00000000-0000-4000-8000-000000000103";
    const check = sql.raw("menu_items_portion_weight_kg_positive");

    afterAll(async () => {
      await db.delete(wasteEntries).where(sql`${wasteEntries.itemId} = ${kerupuk}`);
      await db.delete(menuItems).where(sql`${menuItems.id} = ${kerupuk}`);
      await db.execute(
        sql`alter table menu_items add constraint ${check} check (portion_weight_kg > 0)`,
      );
    });

    beforeAll(async () => {
      await db.execute(sql`alter table menu_items drop constraint ${check}`);
      await db.insert(menuItems).values({
        id: kerupuk,
        outletId: A,
        name: "Kerupuk",
        category: "side",
        costPerPortion: "1000",
        portionWeightKg: "0.000",
        foodCategory: "other",
      });
      await db.insert(wasteEntries).values({
        outletId: A,
        itemId: kerupuk,
        loggedAt: new Date("2026-04-01T05:00:00Z"),
        weightKg: "0.500",
        cause: "expired",
        source: "text",
      });
      await db.insert(wasteEntries).values({
        outletId: A,
        itemId: ids.nasi,
        loggedAt: new Date("2026-04-01T06:00:00Z"),
        weightKg: "0.400",
        cause: "spoilage",
        source: "text",
      });
    });

    it("does not break query_waste; it counts toward kg but not portions or cost", async () => {
      const filters = { outlet_id: A, from: "2026-04-01", to: "2026-04-01" };
      const all = await queryWaste(db, { filters, group_by: "none" });
      expect(all.groups).toEqual([{ waste_kg: 0.9, entries: 2, portions: 2, cost_idr: 5000 }]);
      const byItem = await queryWaste(db, { filters, group_by: "item" });
      expect(byItem.groups.find((g) => g.item_name === "Kerupuk")).toMatchObject({
        waste_kg: 0.5,
        portions: 0,
        cost_idr: 0,
      });
    });

    it("rejects portions for it in log_waste and update_entry, but accepts a typed weight", async () => {
      const base = { outlet_id: A, cause: "expired", source: "text" } as const;
      await rejects(
        logOne(db, { ...base, item_id: kerupuk, portion_count: 3 }),
        /has no portion weight.*log weight_kg instead/,
      );
      const { entry } = await logOne(db, { ...base, item_id: kerupuk, weight_kg: 0.2 });
      expect(entry).toMatchObject({ weight_kg: 0.2, portion_count: null });

      const counted = (await logOne(db, { ...base, item_id: ids.nasi, portion_count: 2 })).entry;
      await rejects(
        updateEntry(db, { outlet_id: A, id: counted.id, patch: { item_id: kerupuk } }),
        /has no portion weight/,
      );
    });
  });
});
