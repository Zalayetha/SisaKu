import { describe, expect, it } from "vitest";
import { parseCliOptions } from "./options.js";

describe("parseCliOptions", () => {
  it("uses defaults and parses valid flags", () => {
    expect(parseCliOptions([])).toMatchObject({ reset: false, dryRun: false });
    expect(parseCliOptions(["--seed", "7", "--days", "30", "--start", "2026-02-01", "--reset"])).toEqual({
      seed: 7,
      days: 30,
      start: "2026-02-01",
      reset: true,
      dryRun: false,
    });
  });

  it.each([
    [["--seed", "6o"]],
    [["--seed"]],
    [["--seed", "--reset"]],
    [["--days", "abc"]],
    [["--days", "13"]],
    [["--days", "1.5"]],
    [["--start", "2026-13-01"]],
    [["--start", "2026-02-30"]],
    [["--start", "tomorrow"]],
    [["--bogus"]],
  ])("rejects %j", (args) => {
    expect(() => parseCliOptions(args)).toThrow();
  });
});
