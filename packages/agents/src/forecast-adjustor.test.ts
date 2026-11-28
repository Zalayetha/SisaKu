import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION,
  forecastAdjustorInstructionsFingerprint,
  parseForecastAdjustments,
} from "./forecast-adjustor";

const changelog = readFileSync(
  new URL("../FORECAST-ADJUSTOR-CHANGELOG.md", import.meta.url),
  "utf8",
);
const entries = changelog.split(/^(?=## )/m).slice(1);

describe("forecast adjustor instructions changelog", () => {
  it("has an entry for the current instructions version, newest first", () => {
    const versions = entries.map((e) => /^## (\S+)/.exec(e)![1]);
    expect(versions[0]).toBe(FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("fails when the instructions change without a new version", () => {
    const fingerprint = forecastAdjustorInstructionsFingerprint();
    const pinned = /^- Fingerprint: `(\w+)`/m.exec(entries[0]!)?.[1];
    expect(
      pinned,
      `FORECAST_ADJUSTOR_INSTRUCTIONS changed: bump FORECAST_ADJUSTOR_INSTRUCTIONS_VERSION and add a changelog entry with "- Fingerprint: \`${fingerprint}\`"`,
    ).toBe(fingerprint);
  });
});

describe("parseForecastAdjustments", () => {
  const items = [
    { item_id: "item-nasi", baseline_qty: 100 },
    { item_id: "item-rendang", baseline_qty: 40 },
    { item_id: "item-zero", baseline_qty: 0 },
  ];

  it("parses valid adjustments, rounds to 1 decimal place, and drops items equal to baseline", () => {
    const text = JSON.stringify({
      adjustments: [
        {
          item_id: "item-nasi",
          adjusted_qty: 85.46,
          reason: "Ramadan reduces daytime dine-in demand",
        },
        {
          item_id: "item-rendang",
          adjusted_qty: 40.04, // rounds to 40 -> equal to baseline, treated as unadjusted
          reason: "",
        },
      ],
    });
    const parsed = parseForecastAdjustments(text, items);
    expect(parsed.size).toBe(1);
    expect(parsed.get("item-nasi")).toEqual({
      item_id: "item-nasi",
      adjusted_qty: 85.5,
      reason: "Ramadan reduces daytime dine-in demand",
    });
  });

  it("accepts JSON wrapped in a markdown code fence", () => {
    const text =
      '```json\n{"adjustments":[{"item_id":"item-nasi","adjusted_qty":90,"reason":"Heavy rain reduces walk-ins"}]}\n```';
    const parsed = parseForecastAdjustments(text, items);
    expect(parsed.get("item-nasi")).toEqual({
      item_id: "item-nasi",
      adjusted_qty: 90,
      reason: "Heavy rain reduces walk-ins",
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["missing adjustments array", '{"items": []}'],
    [
      "negative adjusted_qty",
      JSON.stringify({
        adjustments: [{ item_id: "item-nasi", adjusted_qty: -5, reason: "Negative" }],
      }),
    ],
    [
      "unknown item_id",
      JSON.stringify({
        adjustments: [{ item_id: "item-unknown", adjusted_qty: 50, reason: "Holiday" }],
      }),
    ],
    [
      "duplicate item_id",
      JSON.stringify({
        adjustments: [
          { item_id: "item-nasi", adjusted_qty: 90, reason: "Rain" },
          { item_id: "item-nasi", adjusted_qty: 85, reason: "Rain again" },
        ],
      }),
    ],
    [
      "zero-baseline item",
      JSON.stringify({
        adjustments: [{ item_id: "item-zero", adjusted_qty: 10, reason: "Holiday" }],
      }),
    ],
    [
      "missing reason on changed item",
      JSON.stringify({
        adjustments: [{ item_id: "item-nasi", adjusted_qty: 90, reason: "   " }],
      }),
    ],
  ])("throws on %s", (_label, text) => {
    expect(() => parseForecastAdjustments(text, items)).toThrow();
  });
});
