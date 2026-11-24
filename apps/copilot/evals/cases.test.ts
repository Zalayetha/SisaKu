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
import { CHART_TOOL_NAME, chartInput } from "../src/charts/chart-tool";
import { PROPOSE_TOOL_NAME, proposeInput } from "../src/waste/propose-tool";
import { EVAL_OUTLET, savedEntries, toolCallCases } from "./cases";
import { hasPath, isObject } from "./metrics";

const AREAS = {
  waste_total: 6,
  why_spike: 4,
  sales: 3,
  breakdown: 3,
  chart: 2,
  co2e: 2,
  prep_log: 1,
  waste_logging: 2,
  correction: 4,
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

// One valid value per kind of optional argument.
const SAMPLES = [OUTLET, "over_prep", "2026-04-01T05:00:00Z", 1];

/** `input` with `path` set to `sample` (in every element of an array). */
function withPath(input: unknown, path: string, sample: unknown): unknown {
  if (Array.isArray(input)) return input.map((v) => withPath(v, path, sample));
  if (!isObject(input)) return input;
  const [key, ...rest] = path.split(".");
  const value = rest.length > 0 ? withPath(input[key!], rest.join("."), sample) : sample;
  return { ...input, [key!]: value };
}

describe("tool-call eval cases", () => {
  const mock = generateMockData();

  it("has 29 cases with unique ids, in the agreed mix of areas and languages", () => {
    expect(mock.outlets.map((o) => o.name)).toContain(EVAL_OUTLET);
    expect(toolCallCases).toHaveLength(29);
    expect(new Set(toolCallCases.map((c) => c.id)).size).toBe(29);
    const areas: Record<string, number> = {};
    for (const c of toolCallCases) areas[c.metadata.area] = (areas[c.metadata.area] ?? 0) + 1;
    expect(areas).toEqual(AREAS);
    expect(toolCallCases.filter((c) => c.metadata.language === "id")).toHaveLength(18);
    for (const c of toolCallCases) {
      expect(["staff", "manager", "owner"]).toContain(c.input.role);
      // Only the saved-entry corrections run later, each on the day of its own entry.
      const days = [mock.endDate, ...savedEntries.map((e) => e.day)];
      expect(days, c.id).toContain(c.input.today);
      expect(c.input.message.trim()).not.toBe("");
    }
  });

  it("gives history as user/assistant pairs, as the chat history holds it", () => {
    for (const c of toolCallCases.filter((c) => c.input.history)) {
      expect(c.input.history!.length % 2, c.id).toBe(0);
      c.input.history!.forEach((m, i) => {
        expect(m.role, c.id).toBe(i % 2 === 0 ? "user" : "assistant");
        expect(m.content.trim(), c.id).not.toBe("");
      });
    }
    expect(toolCallCases.some((c) => c.input.history)).toBe(true);
  });

  it("gives each saved entry its own day after the mock data, used by one case", () => {
    expect(new Set(savedEntries.map((e) => e.day)).size).toBe(savedEntries.length);
    for (const entry of savedEntries) {
      expect(entry.day > mock.endDate, entry.day).toBe(true);
      expect(toolCallCases.filter((c) => c.input.today === entry.day)).toHaveLength(1);
      const menuItem = mock.menuItems.find((m) => m.id === entry.itemId)!;
      expect(Number(entry.weightKg)).toBeCloseTo(
        entry.portionCount * Number(menuItem.portionWeightKg),
        3,
      );
    }
  });

  it("expects only tools the Copilot is offered, or no tool", () => {
    const offered = new Set<string>([
      ...COPILOT_TOOL_ALLOWLIST,
      PROPOSE_TOOL_NAME,
      CHART_TOOL_NAME,
    ]);
    for (const c of toolCallCases) {
      if (c.expected.tool === null) {
        expect(c.metadata.area, c.id).toBe("no_tool");
        expect(c.expected.args, c.id).toBeUndefined();
        expect(c.expected.absent, c.id).toBeUndefined();
      } else {
        expect(offered.has(c.expected.tool), c.id).toBe(true);
      }
    }
  });

  it.each(toolCallCases.filter((c) => c.expected.tool !== null).map((c) => [c.id, c] as const))(
    "%s: expected arguments pass the tool's real input schema",
    (_id, c) => {
      const args = c.expected.args ?? {};
      expect(JSON.stringify(args)).not.toContain("outlet_id");
      const tool = TOOLS[c.expected.tool!]!;
      const input = merge(tool.filler, args);
      const parsed = tool.schema.safeParse(input);
      expect(parsed.error?.issues ?? []).toEqual([]);
      // Zod drops unknown keys, so a misspelled key shows up as a difference here.
      expect(parsed.data).toEqual(input);
    },
  );

  it.each(toolCallCases.filter((c) => c.expected.absent).map((c) => [c.id, c] as const))(
    "%s: absent arguments are optional ones the tool knows",
    (_id, c) => {
      const tool = TOOLS[c.expected.tool!]!;
      const inputs = [tool.filler, merge(tool.filler, c.expected.args ?? {})];
      for (const path of c.expected.absent!) {
        expect(hasPath(c.expected.args, path), path).toBe(false);
        const known = inputs.some((input) =>
          SAMPLES.some((sample) => {
            const parsed = tool.schema.safeParse(withPath(input, path, sample));
            return parsed.success && hasPath(parsed.data, path);
          }),
        );
        expect(known, path).toBe(true);
      }
    },
  );
});
