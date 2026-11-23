import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPILOT_INSTRUCTIONS, COPILOT_INSTRUCTIONS_VERSION } from "./instructions";

const changelog = readFileSync(new URL("../INSTRUCTIONS-CHANGELOG.md", import.meta.url), "utf8");
const entries = changelog.split(/^(?=## )/m).slice(1);

describe("instructions changelog", () => {
  it("has an entry for the current instructions version, newest first", () => {
    const versions = entries.map((e) => /^## (\S+)/.exec(e)![1]);
    expect(versions[0]).toBe(COPILOT_INSTRUCTIONS_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("fails when the instructions change without a new version", () => {
    const fingerprint = createHash("sha256")
      .update(COPILOT_INSTRUCTIONS)
      .digest("hex")
      .slice(0, 16);
    const pinned = /^- Fingerprint: `(\w+)`/m.exec(entries[0]!)?.[1];
    expect(
      pinned,
      `COPILOT_INSTRUCTIONS changed: bump COPILOT_INSTRUCTIONS_VERSION and add a changelog entry with "- Fingerprint: \`${fingerprint}\`"`,
    ).toBe(fingerprint);
  });
});
