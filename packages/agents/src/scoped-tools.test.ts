import type { McpClientGroup } from "@anvia/mcp";
import type { ListEntriesOutput, QueryWasteOutput } from "@sisaku/kitchen-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../kitchen-mcp/src/test-fixture";
import { parseToolJson } from "./mcp";
import { scopedTools } from "./scoped-tools";
import { connectInMemoryServers } from "./testing/mcp-servers";

// Scoping for an agent that acts for an outlet with no user, such as a nightly pipeline step.

describe.skipIf(!testDbUrl)("scoped tools for an outlet without a user", () => {
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  const READ_TOOLS = ["get_sales", "get_prep_log", "query_waste", "list_entries"];

  beforeAll(async () => {
    const test = await setupTestDb();
    pool = test.pool;
    mcp = await connectInMemoryServers(test.db);
  });
  afterAll(async () => {
    await mcp?.close();
    await pool?.end();
  });

  it("hides outlet_id from the read tools' schemas", async () => {
    const tools = await scopedTools(mcp.servers, READ_TOOLS, { outletId: ids.outletA });
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    const definitions = await Promise.all(tools.map((t) => t.definition("")));
    expect(JSON.stringify(definitions)).not.toContain("outlet_id");
  });

  it("reads the scoped outlet, whatever outlet the model names", async () => {
    const tools = await scopedTools(mcp.servers, READ_TOOLS, { outletId: ids.outletA });
    const listEntries = tools.find((t) => t.name === "list_entries")!;
    const result = parseToolJson<ListEntriesOutput>(
      await listEntries.call({ outlet_id: ids.outletB, from: "2026-03-01", to: "2026-03-02" }),
    );
    expect(result.outlet_id).toBe(ids.outletA);
    const entryIds = result.entries.map((e) => e.id);
    expect(entryIds).toContain(ids.wasteRendangDay1);
    expect(entryIds).not.toContain(ids.wasteSotoB);
  });

  it("reads the scoped outlet when outlet_id is nested in the filters", async () => {
    const tools = await scopedTools(mcp.servers, READ_TOOLS, { outletId: ids.outletA });
    const queryWaste = tools.find((t) => t.name === "query_waste")!;
    const filters = { outlet_id: ids.outletB, from: "2026-03-01", to: "2026-03-01" };
    const result = parseToolJson<QueryWasteOutput>(
      await queryWaste.call({ filters, group_by: "item" }),
    );
    expect(result.groups.map((g) => g.item_id)).toContain(ids.rendang);
    expect(result.groups.map((g) => g.item_id)).not.toContain(ids.soto);
  });

  it("refuses to scope a tool that records who confirmed, before it can be called", async () => {
    await expect(
      scopedTools(mcp.servers, [...READ_TOOLS, "log_waste"], { outletId: ids.outletA }),
    ).rejects.toThrow(/log_waste.*user/);
  });
});
