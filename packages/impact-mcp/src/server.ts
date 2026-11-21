import { McpServer } from "@modelcontextprotocol/server";
import {
  computeCo2e,
  draftPickup,
  findFoodbanks,
  getFactor,
  ImpactError,
  submitPickup,
  type Db,
} from "./impact";
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
      if (e instanceof ImpactError) return fail(e.message);
      // stderr only: on stdio, stdout carries the protocol.
      console.error("impact-mcp tool error:", e);
      return fail("Internal error in impact-mcp; details are in the server log.");
    }
  };
}

export function createImpactServer(db: Db) {
  const server = new McpServer(
    { name: "sisaku-impact-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "get_factor",
    {
      title: "Get emission factor",
      description:
        "Emission factors for a food category, in kg CO2e per kg of food waste: production (Our World in Data) and landfill (IPCC defaults), their total, and the source to cite.",
      inputSchema: s.getFactorInput,
      outputSchema: s.factorOutput,
      annotations: read,
    },
    handle(db, getFactor),
  );

  server.registerTool(
    "compute_co2e",
    {
      title: "Compute CO2e of waste",
      description:
        "Estimated kg CO2e of one outlet's logged waste over local days (the outlet's timezone), optionally for one item or cause; the same filters as query_waste. Returns totals, a breakdown per food category with sources, and uncovered waste whose category has no factor. Use these numbers as-is and call them estimates.",
      inputSchema: s.computeCo2eInput,
      outputSchema: s.computeCo2eOutput,
      annotations: read,
    },
    handle(db, computeCo2e),
  );

  server.registerTool(
    "find_foodbanks",
    {
      title: "Find food banks",
      description:
        "Food banks (mock data) near an area; defaults to the outlet's location. An empty location returns all.",
      inputSchema: s.findFoodbanksInput,
      outputSchema: s.findFoodbanksOutput,
      annotations: read,
    },
    handle(db, findFoodbanks),
  );

  server.registerTool(
    "draft_pickup",
    {
      title: "Draft a food bank pickup",
      description:
        "Record a pickup request for menu items and portion counts, waiting for a manager's approval (status pending). This does not contact the food bank. Approval is given by a manager outside this tool.",
      inputSchema: s.draftPickupInput,
      outputSchema: s.pickupResult,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(db, draftPickup),
  );

  server.registerTool(
    "submit_pickup",
    {
      title: "Submit an approved pickup",
      description:
        "Record that an approved pickup request is submitted. Refused unless a manager or owner of the outlet approved it. Only call after the manager explicitly said yes; never to get around a refusal.",
      inputSchema: s.submitPickupInput,
      outputSchema: s.pickupResult,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handle(db, submitPickup),
  );

  return server;
}
