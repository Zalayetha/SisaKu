import type { Config } from "vega-lite";
import type { ChartSpec } from "./render";

export type Metric = "waste_kg" | "cost_idr";

export type TrendPoint = { date: string; value: number };
export type VsSalesPoint = { date: string; series: "Limbah" | "Terjual"; portions: number };
export type BreakdownBar = { label: string; value: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const UNIT_LABEL: Record<Metric, string> = { waste_kg: "kg", cost_idr: "Rp" };

/** "10–12 Feb 2026", "28 Feb – 3 Mar 2026" or "28 Des 2025 – 3 Jan 2026". */
export function rangeLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const end = `${td} ${MONTHS[tm - 1]} ${ty}`;
  if (from === to) return end;
  if (fy !== ty) return `${fd} ${MONTHS[fm - 1]} ${fy} – ${end}`;
  if (fm !== tm) return `${fd} ${MONTHS[fm - 1]} – ${end}`;
  return `${fd}–${end}`;
}

/** Every calendar day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`);) {
    days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return days;
}

// Fixed Bahasa Indonesia text and Indonesian number format, like the waste card.
const config: Config = {
  font: "Noto Sans",
  locale: { number: { decimal: ",", thousands: ".", grouping: [3], currency: ["Rp", ""] } },
  title: { fontSize: 15, anchor: "start" },
};
const base = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  config,
  background: "white",
  padding: 12,
};

const dayAxis = {
  field: "date",
  type: "ordinal" as const,
  title: "Tanggal",
  sort: "ascending" as const,
  axis: {
    labelExpr: "utcFormat(toDate(datum.value), '%d/%m')",
    labelAngle: 0,
    labelOverlap: true,
  },
};

export function trendSpec(title: string, metric: Metric, points: TrendPoint[]): ChartSpec {
  return {
    ...base,
    title,
    width: 600,
    height: 300,
    data: { values: points },
    mark: { type: "line", point: true },
    encoding: {
      x: dayAxis,
      y: { field: "value", type: "quantitative", title: UNIT_LABEL[metric] },
    },
  };
}

export function vsSalesSpec(title: string, points: VsSalesPoint[]): ChartSpec {
  return {
    ...base,
    title,
    data: { values: points },
    mark: { type: "line", point: true },
    encoding: {
      row: { field: "series", type: "nominal", title: null, sort: ["Limbah", "Terjual"] },
      x: dayAxis,
      y: { field: "portions", type: "quantitative", title: "porsi" },
      color: {
        field: "series",
        type: "nominal",
        legend: null,
        scale: { domain: ["Limbah", "Terjual"], range: ["#c2410c", "#2563eb"] },
      },
    },
    width: 600,
    height: 150,
    resolve: { scale: { y: "independent" } },
  };
}

export function breakdownSpec(title: string, metric: Metric, bars: BreakdownBar[]): ChartSpec {
  return {
    ...base,
    title,
    width: 600,
    height: { step: 28 },
    data: { values: bars },
    mark: { type: "bar" },
    encoding: {
      y: { field: "label", type: "nominal", title: null, sort: "-x" },
      x: { field: "value", type: "quantitative", title: UNIT_LABEL[metric] },
    },
  };
}
