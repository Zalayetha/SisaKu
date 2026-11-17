import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@sisaku/impact-mcp", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@sisaku/impact-mcp");
  });
});
