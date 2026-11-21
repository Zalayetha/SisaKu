import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { importCsv, pickupRequests } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "./impact";
import { ESTIMATE_NOTE } from "./schemas";
import { createImpactServer } from "./server";
import { ids, setupTestDb, testDbUrl, unknownId } from "./test-fixture";

// Every behaviour is tested the way an agent sees it: by calling a tool through an MCP client.

type TestPool = Awaited<ReturnType<typeof setupTestDb>>["pool"];

async function connect(db: Db) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createImpactServer(db).connect(serverSide);
  const client = new Client({ name: "impact-mcp-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

const A = ids.outletA;

// Schema validation runs before any handler, so these tests need no database: the db is a stub
// that fails loudly if a handler ever reaches it.
describe("impact-mcp protocol, without a database", () => {
  let client: Client;
  const leaky = new Error('relation "secret_table" does not exist');
  const stubDb = new Proxy({} as Db, {
    get: () => () => {
      throw leaky;
    },
  });

  beforeAll(async () => {
    client = await connect(stubDb);
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists exactly the five tools, with input and output schemas and no approve tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compute_co2e",
      "draft_pickup",
      "find_foodbanks",
      "get_factor",
      "submit_pickup",
    ]);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
  });

  const filters = { outlet_id: A, from: "2026-03-01", to: "2026-03-02" };
  const draft = { outlet_id: A, foodbank_id: "fb-jaksel-01" };
  const invalid: [string, string, Record<string, unknown>, RegExp][] = [
    ["get_factor", "an empty category", { food_category: "" }, /food_category/],
    [
      "compute_co2e",
      "a non-uuid outlet",
      { filters: { ...filters, outlet_id: "warung" } },
      /outlet_id/,
    ],
    [
      "compute_co2e",
      "from after to",
      { filters: { ...filters, from: "2026-03-05" } },
      /from must be on or before to/,
    ],
    ["compute_co2e", "an unknown cause", { filters: { ...filters, cause: "dropped" } }, /cause/],
    ["compute_co2e", "flat filters", { ...filters }, /filters/],
    ["find_foodbanks", "a missing outlet", {}, /outlet_id/],
    ["draft_pickup", "an empty item list", { ...draft, items: [] }, /items/],
    [
      "draft_pickup",
      "zero portions",
      { ...draft, items: [{ item_id: ids.nasi, portion_count: 0 }] },
      /portion_count/,
    ],
    [
      "draft_pickup",
      "free-text items",
      { ...draft, items: [{ name: "nasi", weight_kg: 1 }] },
      /item_id/,
    ],
    [
      "draft_pickup",
      "the same item twice",
      {
        ...draft,
        items: [
          { item_id: ids.nasi, portion_count: 1 },
          { item_id: ids.nasi, portion_count: 2 },
        ],
      },
      /Each item_id may appear only once/,
    ],
    ["submit_pickup", "a missing outlet", { id: unknownId }, /outlet_id/],
    ["submit_pickup", "a non-uuid id", { outlet_id: A, id: "draft-1" }, /id/],
  ];

  it.each(invalid)("%s rejects %s", async (name, _case, args, message) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(message);
  });

  it("hides unexpected errors from the client and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await client.callTool({ name: "get_factor", arguments: { food_category: "beef" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Internal error in impact-mcp; details are in the server log.");
    expect(text(r)).not.toContain("secret_table");
    expect(log).toHaveBeenCalledWith("impact-mcp tool error:", leaky);
    log.mockRestore();
  });
});

describe.skipIf(!testDbUrl)("impact-mcp protocol, with Postgres", () => {
  let client: Client;
  let db: Db;
  let pool: TestPool;

  beforeAll(async () => {
    const t = await setupTestDb();
    db = t.db;
    pool = t.pool;
    client = await connect(db);
  });
  afterAll(async () => {
    await client?.close();
    await pool?.end();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, text(r)).toBeFalsy();
    // The text block carries the same data as structuredContent.
    expect(JSON.parse(text(r))).toEqual(r.structuredContent);
    return r.structuredContent as Record<string, any>;
  };
  const refused = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    return text(r);
  };

  describe("get_factor", () => {
    it("returns both factors, their total and the source", async () => {
      expect(await call("get_factor", { food_category: "beef" })).toEqual({
        food_category: "beef",
        production_kg_co2e_per_kg: 10,
        landfill_kg_co2e_per_kg: 1,
        total_kg_co2e_per_kg: 11,
        source: "test beef",
      });
    });
    it("refuses an unknown category", async () => {
      expect(await refused("get_factor", { food_category: "snack" })).toBe(
        'No emission factor for food category "snack"',
      );
    });
  });

  describe("compute_co2e", () => {
    const co2e = (filters: Record<string, unknown>) =>
      call("compute_co2e", { filters: { outlet_id: A, ...filters } });

    it("computes totals and a per-category breakdown, with uncovered waste listed", async () => {
      // beef 0.36 kg x (10 + 1) = 3.6 + 0.36 = 3.96; rice 1.0 kg x (2 + 1) = 2 + 1 = 3;
      // kerupuk 0.5 kg has no factor: counted in waste_kg only.
      const r = await co2e({ from: "2026-03-01", to: "2026-03-02" });
      expect(r).toEqual({
        outlet_id: A,
        from: "2026-03-01",
        to: "2026-03-02",
        timezone: "Asia/Jakarta",
        totals: {
          waste_kg: 1.86,
          entries: 3,
          production_kg_co2e: 5.6,
          landfill_kg_co2e: 1.36,
          total_kg_co2e: 6.96,
        },
        by_category: [
          {
            food_category: "rice",
            waste_kg: 1,
            entries: 1,
            production_kg_co2e: 2,
            landfill_kg_co2e: 1,
            total_kg_co2e: 3,
            source: "test rice",
          },
          {
            food_category: "beef",
            waste_kg: 0.36,
            entries: 1,
            production_kg_co2e: 3.6,
            landfill_kg_co2e: 0.36,
            total_kg_co2e: 3.96,
            source: "test beef",
          },
        ],
        uncovered: [{ food_category: "snack", waste_kg: 0.5, entries: 1 }],
        note: ESTIMATE_NOTE,
      });
    });

    it("uses the outlet's local days", async () => {
      // Nasi was logged at 01:00 local on 03-02 (still 03-01 in UTC), so it is not on 03-01.
      const r = await co2e({ from: "2026-03-01", to: "2026-03-01" });
      expect(r.totals).toMatchObject({ waste_kg: 0.86, entries: 2, total_kg_co2e: 3.96 });
      expect(r.by_category.map((g: { food_category: string }) => g.food_category)).toEqual([
        "beef",
      ]);
    });

    it("filters by cause and item, and returns zeros for a range with no waste", async () => {
      expect(
        (await co2e({ from: "2026-03-01", to: "2026-03-02", cause: "spoilage" })).totals,
      ).toMatchObject({ waste_kg: 1, total_kg_co2e: 3 });
      expect(
        (await co2e({ from: "2026-03-01", to: "2026-03-02", item_id: ids.rendang })).totals,
      ).toMatchObject({ waste_kg: 0.36, total_kg_co2e: 3.96 });
      const empty = await co2e({ from: "2026-05-01", to: "2026-05-31" });
      expect(empty.totals).toEqual({
        waste_kg: 0,
        entries: 0,
        production_kg_co2e: 0,
        landfill_kg_co2e: 0,
        total_kg_co2e: 0,
      });
      expect(empty.by_category).toEqual([]);
      expect(empty.uncovered).toEqual([]);
    });

    it("refuses an unknown outlet or another outlet's item", async () => {
      const range = { from: "2026-03-01", to: "2026-03-02" };
      expect(await refused("compute_co2e", { filters: { ...range, outlet_id: unknownId } })).toBe(
        `Unknown outlet ${unknownId}`,
      );
      expect(
        await refused("compute_co2e", { filters: { ...range, outlet_id: A, item_id: ids.soto } }),
      ).toBe(`Item ${ids.soto} is not on the menu of outlet ${A}`);
    });
  });

  describe("find_foodbanks", () => {
    const names = (r: Record<string, any>) => r.foodbanks.map((f: { id: string }) => f.id);

    it("defaults to the outlet's location", async () => {
      const r = await call("find_foodbanks", { outlet_id: A });
      expect(r.location).toBe("Jakarta Selatan");
      expect(names(r)).toEqual(["fb-jaksel-01", "fb-jaksel-02"]);
    });
    it("matches an area inside a longer location, ignoring case", async () => {
      const r = await call("find_foodbanks", {
        outlet_id: A,
        location: "jl. dago no. 1, BANDUNG",
      });
      expect(names(r)).toEqual(["fb-bdg-01", "fb-bdg-02"]);
    });
    it("returns all for an empty location or an outlet without one, none for an unknown area", async () => {
      expect(names(await call("find_foodbanks", { outlet_id: A, location: "" }))).toHaveLength(5);
      const c = await call("find_foodbanks", { outlet_id: ids.outletC });
      expect(c.location).toBeNull();
      expect(names(c)).toHaveLength(5);
      expect(names(await call("find_foodbanks", { outlet_id: A, location: "Surabaya" }))).toEqual(
        [],
      );
    });
  });

  describe("draft_pickup and submit_pickup", () => {
    const items = [
      { item_id: ids.rendang, portion_count: 5 },
      { item_id: ids.nasi, portion_count: 3 },
    ];
    const draft = async () =>
      (await call("draft_pickup", { outlet_id: A, foodbank_id: "fb-jaksel-01", items })).pickup;
    // Approval is recorded outside impact-mcp (the Telegram approval handler); simulate it.
    const setApproval = (id: string, status: "approved" | "rejected", approvedBy: string | null) =>
      db.update(pickupRequests).set({ status, approvedBy }).where(eq(pickupRequests.id, id));
    const submit = (id: string, outlet_id: string = A) =>
      client.callTool({
        name: "submit_pickup",
        arguments: { outlet_id, id },
      });
    const refusedSubmit = async (id: string, outlet_id: string = A) => {
      const r = await submit(id, outlet_id);
      expect(r.isError).toBe(true);
      return text(r);
    };

    it("drafts a pickup waiting for approval", async () => {
      const p = await draft();
      expect(p).toMatchObject({
        outlet_id: A,
        foodbank_id: "fb-jaksel-01",
        items,
        status: "pending",
        approved_by: null,
      });
    });

    it("refuses another outlet's item, an unknown food bank or an unknown outlet", async () => {
      expect(
        await refused("draft_pickup", {
          outlet_id: A,
          foodbank_id: "fb-jaksel-01",
          items: [{ item_id: ids.soto, portion_count: 1 }],
        }),
      ).toBe(`Not on the menu of outlet ${A}: ${ids.soto}`);
      expect(
        await refused("draft_pickup", { outlet_id: A, foodbank_id: "fb-real-org", items }),
      ).toBe("Unknown food bank fb-real-org; use an id from find_foodbanks");
      expect(
        await refused("draft_pickup", { outlet_id: unknownId, foodbank_id: "fb-jaksel-01", items }),
      ).toBe(`Unknown outlet ${unknownId}`);
    });

    it("refuses to submit a pending request", async () => {
      const p = await draft();
      expect(await refusedSubmit(p.id)).toBe(
        `Pickup request ${p.id} cannot be submitted: it is pending; a manager or owner must approve it first`,
      );
    });

    it("refuses to submit a rejected request", async () => {
      const p = await draft();
      await setApproval(p.id, "rejected", ids.managerA);
      expect(await refusedSubmit(p.id)).toMatch(/it is rejected/);
    });

    it("refuses an approved request without an approver", async () => {
      const p = await draft();
      await setApproval(p.id, "approved", null);
      expect(await refusedSubmit(p.id)).toMatch(/marked approved but has no approver/);
    });

    it("refuses a request approved by staff or by a manager of another outlet", async () => {
      for (const approver of [ids.staffA, ids.managerB]) {
        const p = await draft();
        await setApproval(p.id, "approved", approver);
        expect(await refusedSubmit(p.id)).toMatch(
          /approved by someone who is not a manager or owner of this outlet/,
        );
      }
    });

    it("submits a request approved by a manager once, and refuses a second submit", async () => {
      const p = await draft();
      await setApproval(p.id, "approved", ids.managerA);
      const r = await submit(p.id);
      expect(r.isError, text(r)).toBeFalsy();
      expect((r.structuredContent as any).pickup).toMatchObject({
        id: p.id,
        status: "submitted",
        approved_by: ids.managerA,
      });
      expect(await refusedSubmit(p.id)).toMatch(/already submitted/);
    });

    it("submits a request approved by the owner", async () => {
      const p = await draft();
      await setApproval(p.id, "approved", ids.ownerA);
      expect((await submit(p.id)).isError).toBeFalsy();
    });

    it("does not reveal or submit another outlet's request, and refuses unknown ids", async () => {
      const p = await draft();
      await setApproval(p.id, "approved", ids.managerA);
      expect(await refusedSubmit(p.id, ids.outletB)).toBe(
        `Unknown pickup request ${p.id} for outlet ${ids.outletB}`,
      );
      expect(await refusedSubmit(unknownId)).toBe(
        `Unknown pickup request ${unknownId} for outlet ${A}`,
      );
      expect(await refusedSubmit(p.id, unknownId)).toBe(`Unknown outlet ${unknownId}`);
      const [row] = await db.select().from(pickupRequests).where(eq(pickupRequests.id, p.id));
      expect(row!.status).toBe("approved");
    });
  });

  // Runs last: it replaces the simple factors with the committed seed.
  it("hand check with the committed factors: 0.36 kg rendang + 1.0 kg nasi = 41.81 kg CO2e", async () => {
    const seed = readFileSync(
      new URL("../../db/seed/emission_factors.csv", import.meta.url),
      "utf8",
    );
    expect((await importCsv(db, { emission_factors: seed })).ok).toBe(true);
    // beef 0.36 x (99.48 + 1.134) = 36.22; rice 1.0 x (4.45 + 1.134) = 5.58.
    const r = await call("compute_co2e", {
      filters: { outlet_id: A, from: "2026-03-01", to: "2026-03-02" },
    });
    expect(r.totals.total_kg_co2e).toBe(41.81);
    expect(
      Object.fromEntries(
        r.by_category.map((g: { food_category: string; total_kg_co2e: number }) => [
          g.food_category,
          g.total_kg_co2e,
        ]),
      ),
    ).toEqual({ beef: 36.22, rice: 5.58 });
  });
});
