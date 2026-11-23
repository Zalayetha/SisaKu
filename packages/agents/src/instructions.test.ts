import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPILOT_INSTRUCTIONS_VERSION } from "./instructions";

const changelog = readFileSync(new URL("../INSTRUCTIONS-CHANGELOG.md", import.meta.url), "utf8");

describe("instructions changelog", () => {
  it("has an entry for the current instructions version, newest first", () => {
    const versions = [...changelog.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
    expect(versions[0]).toBe(COPILOT_INSTRUCTIONS_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
