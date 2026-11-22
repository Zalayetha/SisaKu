import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "./kitchen";
import { createKitchenServer } from "./server";
import { ids, setupTestDb, testDbUrl, unknownId } from "./test-fixture";

type TestPool = Awaited<ReturnType<typeof setupTestDb>>["pool"];

async function connect(db: Db) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createKitchenServer(db).connect(serverSide);
  const client = new Client({ name: "kitchen-mcp-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

const A = ids.outletA;

// Schema validation runs before any handler, so these tests need no database: the db is a stub
// that fails loudly if a handler ever reaches it.
describe("kitchen-mcp protocol, without a database", () => {
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

  it("lists the six tools with input and output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_menu",
      "get_prep_log",
      "get_sales",
      "log_waste",
      "query_waste",
      "update_entry",
    ]);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
    const logWaste = tools.find((t) => t.name === "log_waste")!;
    expect(logWaste.inputSchema.properties?.cause).toMatchObject({
      enum: ["over_prep", "spoilage", "plate_waste", "prep_error", "expired"],
    });
  });

  const invalid: [string, string, Record<string, unknown>, RegExp][] = [
    [
      "get_sales",
      "a non-uuid outlet",
      { outlet_id: "warung", from: "2026-03-01", to: "2026-03-02" },
      /outlet_id/,
    ],
    [
      "get_sales",
      "from after to",
      { outlet_id: A, from: "2026-03-05", to: "2026-03-01" },
      /from must be on or before to/,
    ],
    ["get_sales", "a malformed date", { outlet_id: A, from: "2026-3-1", to: "2026-03-02" }, /from/],
    ["get_menu", "a missing outlet", {}, /outlet_id/],
    ["get_prep_log", "an impossible date", { outlet_id: A, date: "2026-02-30" }, /date/],
    [
      "log_waste",
      "both portions and weight",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1, weight_kg: 1 }],

        cause: "spoilage",
        source: "text",
      },
      /exactly one of portion_count or weight_kg/,
    ],
    [
      "log_waste",
      "neither portions nor weight",
      { outlet_id: A, lines: [{ item_id: ids.nasi }], cause: "spoilage", source: "text" },
      /exactly one of portion_count or weight_kg/,
    ],
    [
      "log_waste",
      "no lines",
      { outlet_id: A, lines: [], cause: "spoilage", source: "text" },
      /lines/,
    ],
    [
      "log_waste",
      "more than five lines",
      {
        outlet_id: A,
        lines: Array.from({ length: 6 }, () => ({ item_id: ids.nasi, portion_count: 1 })),
        cause: "spoilage",
        source: "text",
      },
      /lines/,
    ],
    [
      "log_waste",
      "an unknown cause",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],
        cause: "dropped",
        source: "text",
      },
      /cause/,
    ],
    [
      "log_waste",
      "zero portions",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 0 }],
        cause: "spoilage",
        source: "text",
      },
      /portion_count/,
    ],
    [
      "log_waste",
      "a negative weight",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, weight_kg: -1 }],
        cause: "spoilage",
        source: "text",
      },
      /weight_kg/,
    ],
    [
      "log_waste",
      "confidence above 1",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],

        cause: "spoilage",
        source: "photo",

        confidence: 1.5,
      },
      /confidence/,
    ],
    [
      "log_waste",
      "a photo path with ..",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],

        cause: "spoilage",
        source: "photo",

        photo_path: "../etc/passwd",
      },
      /photo_path must be a relative path/,
    ],
    [
      "log_waste",
      "an absolute photo path",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],

        cause: "spoilage",
        source: "photo",

        photo_path: "/data/photos/x.jpg",
      },
      /photo_path must be a relative path/,
    ],
    [
      "log_waste",
      "a photo URL",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],

        cause: "spoilage",
        source: "photo",

        photo_path: "https://api.telegram.org/file/bot123/x.jpg",
      },
      /photo_path must be a relative path/,
    ],
    [
      "log_waste",
      "a time without offset",
      {
        outlet_id: A,
        lines: [{ item_id: ids.nasi, portion_count: 1 }],

        cause: "spoilage",
        source: "text",

        logged_at: "yesterday",
      },
      /logged_at/,
    ],
    [
      "query_waste",
      "an unknown group_by",
      { filters: { outlet_id: A, from: "2026-03-01", to: "2026-03-02" }, group_by: "week" },
      /group_by/,
    ],
    [
      "query_waste",
      "from after to",
      { filters: { outlet_id: A, from: "2026-03-05", to: "2026-03-01" }, group_by: "none" },
      /from must be on or before to/,
    ],
    [
      "update_entry",
      "an empty patch",
      { outlet_id: A, id: ids.wasteNasiDay2, patch: {} },
      /patch must change at least one field/,
    ],
    [
      "update_entry",
      "both portions and weight",
      { outlet_id: A, id: ids.wasteNasiDay2, patch: { portion_count: 1, weight_kg: 1 } },
      /at most one of portion_count or weight_kg/,
    ],
  ];

  it.each(invalid)("%s rejects %s", async (name, _case, args, message) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(message);
  });

  it("hides unexpected errors from the client and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await client.callTool({ name: "get_menu", arguments: { outlet_id: A } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Internal error in kitchen-mcp; details are in the server log.");
    expect(text(r)).not.toContain("secret_table");
    expect(log).toHaveBeenCalledWith("kitchen-mcp tool error:", leaky);
    log.mockRestore();
  });
});

describe.skipIf(!testDbUrl)("kitchen-mcp protocol, with Postgres", () => {
  let client: Client;
  let pool: TestPool;

  beforeAll(async () => {
    const t = await setupTestDb();
    pool = t.pool;
    client = await connect(t.db);
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

  it("get_sales", async () => {
    const r = await call("get_sales", { outlet_id: A, from: "2026-03-03", to: "2026-03-03" });
    expect(r.rows).toHaveLength(2);
  });

  it("get_menu", async () => {
    const r = await call("get_menu", { outlet_id: A });
    expect(r.items.map((i: { name: string }) => i.name)).toEqual(["Nasi Putih", "Rendang Sapi"]);
  });

  it("get_prep_log", async () => {
    const r = await call("get_prep_log", { outlet_id: A, date: "2026-03-01" });
    expect(r.rows).toHaveLength(2);
  });

  it("query_waste", async () => {
    const r = await call("query_waste", {
      filters: { outlet_id: A, from: "2026-03-01", to: "2026-03-02" },
      group_by: "none",
    });
    expect(r.groups).toEqual([{ waste_kg: 1.6, entries: 3, portions: 10, cost_idr: 77500 }]);
  });

  it("log_waste and update_entry", async () => {
    const {
      entries: [entry],
    } = await call("log_waste", {
      outlet_id: A,
      lines: [{ item_id: ids.rendang, portion_count: 2 }],

      cause: "plate_waste",
      source: "photo",

      photo_path: `${A}/abc.jpg`,
      confidence: 0.7,
    });
    expect(entry).toMatchObject({ weight_kg: 0.24, photo_path: `${A}/abc.jpg` });
    const r = await call("update_entry", {
      outlet_id: A,
      id: entry.id,
      patch: { portion_count: 3 },
    });
    expect(r.after).toMatchObject({ portion_count: 3, weight_kg: 0.36 });
  });

  it("returns caller-fixable errors as tool errors", async () => {
    const r = await client.callTool({ name: "get_menu", arguments: { outlet_id: unknownId } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`Unknown outlet ${unknownId}`);
  });
});
