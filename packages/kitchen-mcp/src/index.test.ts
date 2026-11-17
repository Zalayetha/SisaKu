import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@sisaku/kitchen-mcp", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@sisaku/kitchen-mcp");
  });
});
