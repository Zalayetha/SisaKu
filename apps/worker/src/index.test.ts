import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@sisaku/worker", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@sisaku/worker");
  });
});
