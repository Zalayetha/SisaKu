import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSpikeExplanation,
  SPIKE_INVESTIGATOR_INSTRUCTIONS_VERSION,
  spikeInvestigatorInstructionsFingerprint,
} from "./spike-investigator";

const changelog = readFileSync(
  new URL("../SPIKE-INVESTIGATOR-CHANGELOG.md", import.meta.url),
  "utf8",
);
const entries = changelog.split(/^(?=## )/m).slice(1);

describe("spike investigator instructions changelog", () => {
  it("has an entry for the current instructions version, newest first", () => {
    const versions = entries.map((e) => /^## (\S+)/.exec(e)![1]);
    expect(versions[0]).toBe(SPIKE_INVESTIGATOR_INSTRUCTIONS_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("fails when the instructions change without a new version", () => {
    const fingerprint = spikeInvestigatorInstructionsFingerprint();
    const pinned = /^- Fingerprint: `(\w+)`/m.exec(entries[0]!)?.[1];
    expect(
      pinned,
      `SPIKE_INVESTIGATOR_INSTRUCTIONS changed: bump SPIKE_INVESTIGATOR_INSTRUCTIONS_VERSION and add a changelog entry with "- Fingerprint: \`${fingerprint}\`"`,
    ).toBe(fingerprint);
  });
});

describe("a spike explanation from the model's answer", () => {
  it.each([
    ['{"kind":"spoilage","evidence":"3 of 4 entries were spoilage."}', "spoilage"],
    ['Here it is: {"kind":"over_prep","evidence":"Prep was 60 against 30."}', "over_prep"],
    ['{"kind":"unexplained"}', "unexplained"],
    ['{"kind":"sales_drop"}', "unexplained"], // no evidence
    ['{"kind":"theft","evidence":"x"}', "unexplained"],
    ["Sales dropped.", "unexplained"],
    ["{not json}", "unexplained"],
  ])("%s is %s", (text, kind) => {
    expect(parseSpikeExplanation(text).kind).toBe(kind);
  });
});
