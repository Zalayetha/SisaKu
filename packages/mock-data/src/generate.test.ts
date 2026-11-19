import { describe, expect, it } from "vitest";
import { addDays, calendarBetween } from "./calendar.js";
import { generateMockData, HELD_OUT_DAYS } from "./generate.js";

describe("generateMockData", () => {
  const data = generateMockData({ seed: 1 });

  it("is deterministic for a seed and differs across seeds", () => {
    expect(generateMockData({ seed: 1 })).toEqual(data);
    expect(generateMockData({ seed: 2 }).sales).not.toEqual(data.sales);
  });

  it("covers 2 outlets over 60 days with a row per item per day", () => {
    expect(data.outlets).toHaveLength(2);
    expect(data.outlets[0]!.name).toBe("Warung Rina");
    expect(data.sales).toHaveLength(data.menuItems.length * 60);
    expect(data.prepLogs).toHaveLength(data.sales.length);
    expect(new Set(data.sales.map((s) => s.date)).size).toBe(60);
  });

  it("keeps references valid and units in kg", () => {
    const items = new Map(data.menuItems.map((i) => [i.id, i]));
    for (const w of data.wasteEntries) {
      const item = items.get(w.itemId)!;
      expect(item.outletId).toBe(w.outletId);
      expect(Number(w.weightKg)).toBeCloseTo(w.portionCount! * Number(item.portionWeightKg), 2);
    }
    for (const s of data.sales) expect(items.get(s.itemId)?.outletId).toBe(s.outletId);
  });

  it("covers Ramadan in the default window", () => {
    expect(calendarBetween(data.startDate, data.endDate).some((e) => e.kind === "ramadan")).toBe(
      true,
    );
  });

  it("places unannounced spikes (off-calendar), including in the held-out window", () => {
    for (const o of data.outlets) {
      const spikes = data.spikes.filter((s) => s.outletId === o.id);
      expect(spikes.length).toBeGreaterThanOrEqual(4);
      expect(spikes.filter((s) => s.date >= data.heldOutFrom).length).toBeGreaterThanOrEqual(2);
      for (const s of spikes) expect(calendarBetween(s.date, s.date)).toHaveLength(0);
    }
    expect(addDays(data.heldOutFrom, HELD_OUT_DAYS - 1)).toBe(data.endDate);
  });

  it("spike days are not predictable from history: sales jump well above same-weekday-last-week", () => {
    const whole = data.spikes.find((s) => s.itemId === null)!;
    const total = (outletId: string, date: string) =>
      data.sales
        .filter((x) => x.outletId === outletId && x.date === date)
        .reduce((a, x) => a + x.qtySold, 0);
    const prev = addDays(whole.date, -7);
    if (prev >= data.startDate)
      expect(total(whole.outletId, whole.date)).toBeGreaterThan(total(whole.outletId, prev) * 1.3);
  });
});
