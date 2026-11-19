import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@sisaku/shared", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@sisaku/shared");
  });
});
