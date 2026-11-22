import { describe, expect, it } from "vitest";
import { COPILOT_TOOL_ALLOWLIST } from "./allowlist";

describe("Copilot tool allowlist", () => {
  it("lists exactly the read tools enabled for ZALS-15", () => {
    expect([...COPILOT_TOOL_ALLOWLIST].sort()).toEqual([
      "compute_co2e",
      "get_factor",
      "get_menu",
      "get_prep_log",
      "get_sales",
      "query_waste",
    ]);
  });

  it("never includes the pipeline's draft_pickup", () => {
    expect(COPILOT_TOOL_ALLOWLIST).not.toContain("draft_pickup");
  });
});
