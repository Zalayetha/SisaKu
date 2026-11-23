import { describe, expect, it } from "vitest";
import { COPILOT_TOOL_ALLOWLIST } from "./allowlist";

describe("Copilot tool allowlist", () => {
  it("lists exactly the read tools, list_entries and update_entry", () => {
    expect([...COPILOT_TOOL_ALLOWLIST].sort()).toEqual([
      "compute_co2e",
      "get_factor",
      "get_menu",
      "get_prep_log",
      "get_sales",
      "list_entries",
      "query_waste",
      "update_entry",
    ]);
  });

  it("never includes the pipeline's draft_pickup", () => {
    expect(COPILOT_TOOL_ALLOWLIST).not.toContain("draft_pickup");
  });

  it("never includes log_waste, which only fixed code calls after a confirmation", () => {
    expect(COPILOT_TOOL_ALLOWLIST).not.toContain("log_waste");
  });
});
