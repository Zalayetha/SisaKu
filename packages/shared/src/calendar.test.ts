import { describe, expect, it } from "vitest";
import { calendarBetween, eventsOn, getCalendar } from "./calendar";

describe("Indonesian calendar lookup", () => {
  it("returns Ramadan events during Ramadan 2026 and 2027", () => {
    expect(getCalendar("2026-02-25").map((e) => ({ name: e.name, kind: e.kind }))).toEqual([
      { name: "Ramadan 2026", kind: "ramadan" },
    ]);
    expect(getCalendar("2027-02-15").map((e) => ({ name: e.name, kind: e.kind }))).toEqual([
      { name: "Ramadan 2027", kind: "ramadan" },
    ]);
  });

  it("returns Eid and plain public holidays", () => {
    expect(getCalendar("2026-03-20").map((e) => ({ name: e.name, kind: e.kind }))).toEqual([
      { name: "Eid al-Fitr 2026", kind: "holiday" },
    ]);
    expect(getCalendar("2026-08-17").map((e) => ({ name: e.name, kind: e.kind }))).toEqual([
      { name: "Independence Day", kind: "holiday" },
    ]);
  });

  it("returns all overlapping events on a date", () => {
    expect(getCalendar("2026-03-19").map((e) => ({ name: e.name, kind: e.kind }))).toEqual([
      { name: "Ramadan 2026", kind: "ramadan" },
      { name: "Nyepi", kind: "holiday" },
    ]);
  });

  it("returns an empty array on normal days with no events", () => {
    expect(getCalendar("2026-06-01")).toEqual([]);
    expect(eventsOn("2026-06-01")).toEqual([]);
  });

  it("finds events overlapping a date range", () => {
    expect(calendarBetween("2026-03-18", "2026-03-21").map((e) => e.name)).toEqual([
      "Ramadan 2026",
      "Nyepi",
      "Eid al-Fitr 2026",
    ]);
  });
});
