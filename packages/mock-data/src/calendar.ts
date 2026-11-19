/**
 * Seeded Indonesian calendar for 2026-2027 (Ramadan, Eid, public holidays).
 * Dates follow the Indonesian government/Kemenag calendar and may shift by a day.
 * `get_calendar` can reuse this later.
 */
export type CalendarKind = "ramadan" | "holiday";

export interface CalendarEvent {
  name: string;
  kind: CalendarKind;
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
  /** Demand multiplier applied by the generator. */
  demandFactor: number;
}

export const CALENDAR: readonly CalendarEvent[] = [
  { name: "New Year", kind: "holiday", start: "2026-01-01", end: "2026-01-01", demandFactor: 0.85 },
  {
    name: "Ramadan 2026",
    kind: "ramadan",
    start: "2026-02-18",
    end: "2026-03-19",
    demandFactor: 0.8,
  },
  { name: "Nyepi", kind: "holiday", start: "2026-03-19", end: "2026-03-19", demandFactor: 0.8 },
  {
    name: "Eid al-Fitr 2026",
    kind: "holiday",
    start: "2026-03-20",
    end: "2026-03-23",
    demandFactor: 0.6,
  },
  {
    name: "Good Friday",
    kind: "holiday",
    start: "2026-04-03",
    end: "2026-04-03",
    demandFactor: 1.1,
  },
  {
    name: "Labour Day",
    kind: "holiday",
    start: "2026-05-01",
    end: "2026-05-01",
    demandFactor: 1.15,
  },
  {
    name: "Eid al-Adha 2026",
    kind: "holiday",
    start: "2026-05-27",
    end: "2026-05-27",
    demandFactor: 0.9,
  },
  {
    name: "Independence Day",
    kind: "holiday",
    start: "2026-08-17",
    end: "2026-08-17",
    demandFactor: 1.2,
  },
  {
    name: "Christmas",
    kind: "holiday",
    start: "2026-12-25",
    end: "2026-12-25",
    demandFactor: 1.15,
  },
  {
    name: "New Year 2027",
    kind: "holiday",
    start: "2027-01-01",
    end: "2027-01-01",
    demandFactor: 0.85,
  },
  {
    name: "Ramadan 2027",
    kind: "ramadan",
    start: "2027-02-08",
    end: "2027-03-09",
    demandFactor: 0.8,
  },
  {
    name: "Eid al-Fitr 2027",
    kind: "holiday",
    start: "2027-03-10",
    end: "2027-03-13",
    demandFactor: 0.6,
  },
];

export function eventsOn(date: string): CalendarEvent[] {
  return CALENDAR.filter((e) => e.start <= date && date <= e.end);
}

export function calendarBetween(from: string, to: string): CalendarEvent[] {
  return CALENDAR.filter((e) => e.end >= from && e.start <= to);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
