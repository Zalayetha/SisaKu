import { COPILOT_TOOL_ALLOWLIST } from "@sisaku/agents";
import { computeCo2eInput } from "@sisaku/impact-mcp";
import {
  getMenuInput,
  getPrepLogInput,
  getSalesInput,
  listEntriesInput,
  queryWasteInput,
  updateEntryInput,
} from "@sisaku/kitchen-mcp";
import { generateMockData } from "@sisaku/mock-data";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { CHART_TOOL_NAME, chartInput } from "../../src/charts/chart-tool";
import { PROPOSE_TOOL_NAME, proposeInput } from "../../src/waste/propose-tool";
import { isObject, loadToolCallDataset, resolveItems } from "../cases";

const dataset = loadToolCallDataset();

const AREAS = {
  waste_total: 5,
  why_spike: 4,
  sales: 3,
  breakdown: 3,
  chart: 2,
  co2e: 2,
  prep_log: 1,
  waste_logging: 2,
  correction: 2,
  no_tool: 2,
};

// The real input schemas. `expected.args` is a subset, so it is merged over a minimal valid
// call (`filler`) before parsing; `outlet_id` is always injected by the turn, never listed.
const OUTLET = "00000000-0000-4000-8000-000000000000";
const day = "2026-04-01";
const TOOLS: Record<string, { schema: ZodType; filler: Record<string, unknown> }> = {
  get_menu: { schema: getMenuInput, filler: { outlet_id: OUTLET } },
  get_sales: { schema: getSalesInput, filler: { outlet_id: OUTLET, from: day, to: day } },
  get_prep_log: { schema: getPrepLogInput, filler: { outlet_id: OUTLET, date: day } },
  query_waste: {
    schema: queryWasteInput,
    filler: { filters: { outlet_id: OUTLET, from: day, to: day }, group_by: "none" },
  },
  list_entries: { schema: listEntriesInput, filler: { outlet_id: OUTLET, from: day, to: day } },
  update_entry: {
    schema: updateEntryInput,
    filler: { outlet_id: OUTLET, id: OUTLET, patch: {} },
  },
  compute_co2e: {
    schema: computeCo2eInput,
    filler: { filters: { outlet_id: OUTLET, from: day, to: day } },
  },
  [PROPOSE_TOOL_NAME]: { schema: proposeInput, filler: {} },
  [CHART_TOOL_NAME]: { schema: chartInput, filler: { kind: "waste_trend", from: day, to: day } },
};

function merge(base: Record<string, unknown>, over: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

describe("tool-call eval dataset", () => {
  const mock = generateMockData();
  const outlet = mock.outlets.find((o) => o.name === dataset.outlet)!;
  const menu = new Map(
    mock.menuItems.filter((m) => m.outletId === outlet.id).map((m) => [m.name, m.id]),
  );

  it("has 26 cases with unique ids, in the agreed mix of areas and languages", () => {
    expect(outlet).toBeDefined();
    expect(dataset.cases).toHaveLength(26);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(26);
    const areas: Record<string, number> = {};
    for (const c of dataset.cases) areas[c.area] = (areas[c.area] ?? 0) + 1;
    expect(areas).toEqual(AREAS);
    expect(dataset.cases.filter((c) => c.language === "id")).toHaveLength(16);
    for (const c of dataset.cases) {
      expect(["staff", "manager", "owner"]).toContain(c.role);
      expect(c.today).toBe(mock.endDate);
      expect(c.message.trim()).not.toBe("");
    }
  });

  it("gives history as user/assistant pairs, as the chat history holds it", () => {
    for (const c of dataset.cases.filter((c) => c.history)) {
      expect(c.history!.length % 2, c.id).toBe(0);
      c.history!.forEach((m, i) => {
        expect(m.role, c.id).toBe(i % 2 === 0 ? "user" : "assistant");
        expect(m.content.trim(), c.id).not.toBe("");
      });
    }
    expect(dataset.cases.some((c) => c.history)).toBe(true);
  });

  it("expects only tools the Copilot is offered, or no tool", () => {
    const offered = new Set<string>([
      ...COPILOT_TOOL_ALLOWLIST,
      PROPOSE_TOOL_NAME,
      CHART_TOOL_NAME,
    ]);
    for (const c of dataset.cases) {
      if (c.expected.tool === null) {
        expect(c.area, c.id).toBe("no_tool");
        expect(c.expected.args, c.id).toBeUndefined();
      } else {
        expect(offered.has(c.expected.tool), c.id).toBe(true);
      }
    }
  });

  it.each(dataset.cases.filter((c) => c.expected.tool !== null).map((c) => [c.id, c] as const))(
    "%s: expected arguments pass the tool's real input schema",
    (_id, c) => {
      const args = resolveItems(c.expected.args ?? {}, menu) as Record<string, unknown>;
      expect(JSON.stringify(args)).not.toContain("outlet_id");
      const tool = TOOLS[c.expected.tool!]!;
      const input = merge(tool.filler, args);
      const parsed = tool.schema.safeParse(input);
      expect(parsed.error?.issues ?? []).toEqual([]);
      // Zod drops unknown keys, so a misspelled key shows up as a difference here.
      expect(parsed.data).toEqual(input);
    },
  );
});
