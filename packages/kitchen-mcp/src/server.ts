import { McpServer } from "@modelcontextprotocol/server";
import {
  getMenu,
  getPrepLog,
  getSales,
  KitchenError,
  listEntries,
  logWaste,
  queryWaste,
  updateEntry,
  type Db,
} from "./kitchen";
import * as s from "./schemas";

/** Serve a result both as typed structuredContent and as JSON text for text-only clients. */
const ok = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data,
});

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Run a tool; caller-fixable errors are shown as-is, anything else is logged and hidden. */
function handle<I>(db: Db, fn: (db: Db, input: I) => Promise<Record<string, unknown>>) {
  return async (input: I) => {
    try {
      return ok(await fn(db, input));
    } catch (e) {
      if (e instanceof KitchenError) return fail(e.message);
      // stderr only: on stdio, stdout carries the protocol.
      console.error("kitchen-mcp tool error:", e);
      return fail("Internal error in kitchen-mcp; details are in the server log.");
    }
  };
}

export function createKitchenServer(db: Db) {
  const server = new McpServer(
    { name: "sisaku-kitchen-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "get_sales",
    {
      title: "Get sales",
      description: `Portions sold per menu item per day for one outlet, from the POS. Dates are inclusive; at most ${s.MAX_SALES_RANGE_DAYS} days per call. Give item_id to narrow to one item.`,
      inputSchema: s.getSalesInput,
      outputSchema: s.getSalesOutput,
      annotations: read,
    },
    handle(db, getSales),
  );

  server.registerTool(
    "get_menu",
    {
      title: "Get menu",
      description:
        "Menu items of one outlet with id, category, cost per portion (Rupiah), portion weight (kg) and food category.",
      inputSchema: s.getMenuInput,
      outputSchema: s.getMenuOutput,
      annotations: read,
    },
    handle(db, getMenu),
  );

  server.registerTool(
    "get_prep_log",
    {
      title: "Get prep log",
      description: "Portions the kitchen prepared per menu item on one day for one outlet.",
      inputSchema: s.getPrepLogInput,
      outputSchema: s.getPrepLogOutput,
      annotations: read,
    },
    handle(db, getPrepLog),
  );

  server.registerTool(
    "log_waste",
    {
      title: "Log waste",
      description:
        "Record confirmed waste: one entry per line (up to 5), sharing cause, source, photo and time. Each line gives exactly one of portion_count (converted to kg with the item's portion weight) or weight_kg. All lines are saved together, or none if any is rejected. Only call after the staff member confirmed the guess.",
      inputSchema: s.logWasteInput,
      outputSchema: s.logWasteOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(db, logWaste),
  );

  server.registerTool(
    "query_waste",
    {
      title: "Query waste",
      description:
        "Waste totals for one outlet over local days (the outlet's timezone), optionally for one item or cause, grouped by item, cause, day or none. Each group has waste_kg, entries, estimated portions and estimated cost in Rupiah (cost_idr). Use these numbers as-is instead of recomputing them.",
      inputSchema: s.queryWasteInput,
      outputSchema: s.queryWasteOutput,
      annotations: read,
    },
    handle(db, queryWaste),
  );

  server.registerTool(
    "list_entries",
    {
      title: "List waste entries",
      description: `Single waste entries of one outlet over local days, newest first, each with its id, item, time, kg, portions and cause; optionally for one item or cause. At most ${s.MAX_LISTED_ENTRIES} entries (truncated is true when more matched). Use it to find the entry to correct with update_entry; use query_waste for totals.`,
      inputSchema: s.listEntriesInput,
      outputSchema: s.listEntriesOutput,
      annotations: read,
    },
    handle(db, listEntries),
  );

  server.registerTool(
    "update_entry",
    {
      title: "Correct a waste entry",
      description:
        "Correct a waste entry's item, cause, time, portion count or weight (at most one of portion_count or weight_kg). Changing the item or portion count recalculates the weight. Returns the entry before and after. Sales and prep logs cannot be changed here; they come from imports.",
      inputSchema: s.updateEntryInput,
      outputSchema: s.updateEntryOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handle(db, updateEntry),
  );

  return server;
}
