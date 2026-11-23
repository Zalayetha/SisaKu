import { createTool } from "@anvia/core";
import { WASTE_CAUSES, type WasteCause } from "@sisaku/db";
import { z } from "zod";
import { CAUSE_LABELS } from "../waste/card";
import type { ChartRenderer, ChartSpec } from "./render";
import {
  breakdownSpec,
  daysBetween,
  rangeLabel,
  trendSpec,
  vsSalesSpec,
  type BreakdownBar,
  type Metric,
  UNIT_LABEL,
} from "./specs";

export const CHART_TOOL_NAME = "send_chart";

/** Longest range one chart covers: the get_sales limit (ADR 0009). */
export const MAX_CHART_DAYS = 92;
const MAX_BARS = 10;

type WasteGroup = {
  item_id?: string;
  item_name?: string;
  cause?: WasteCause;
  date?: string;
  waste_kg: number;
  portions: number;
  cost_idr: number;
};

/** What one chat turn gives the chart tool. Data is read through kitchen-mcp, for this outlet. */
export type ChartContext = {
  menu: readonly { id: string; name: string }[];
  queryWaste: (args: {
    filters: { from: string; to: string; item_id?: string; cause?: string };
    group_by: "item" | "cause" | "day";
  }) => Promise<{ groups: WasteGroup[] }>;
  getSales: (args: {
    from: string;
    to: string;
    item_id: string;
  }) => Promise<{ rows: { date: string; qty_sold: number }[] }>;
  renderer: ChartRenderer;
  log: (message: string, error?: unknown) => void;
  /** Filled in by the tool: the chart to send after the reply. */
  turn: { chart?: { png: Buffer; title: string } };
};

const isoDate = z.iso.date();

export const chartInput = z.object({
  kind: z
    .enum(["waste_trend", "waste_vs_sales", "waste_breakdown"])
    .describe(
      "waste_trend: waste per day. waste_vs_sales: one item's waste portions above its sales per day. waste_breakdown: top items or causes",
    ),
  from: isoDate.describe("First outlet-local day, inclusive (YYYY-MM-DD)"),
  to: isoDate.describe(`Last outlet-local day, inclusive; at most ${MAX_CHART_DAYS} days`),
  metric: z
    .enum(["waste_kg", "cost_idr"])
    .optional()
    .describe("waste_trend and waste_breakdown: kg (default) or estimated Rupiah"),
  item_id: z
    .string()
    .optional()
    .describe("Menu item id; required for waste_vs_sales, optional filter for waste_trend"),
  cause: z.enum(WASTE_CAUSES).optional().describe("waste_trend only: one waste cause"),
  by: z.enum(["item", "cause"]).optional().describe("waste_breakdown only: group by"),
});

type Result =
  | { sent: true; title: string; note: string }
  | { sent: false; reason: "no_data" }
  | { sent: false; error: string };

const fail = (error: string): Result => ({ sent: false, error });
const NO_DATA: Result = { sent: false, reason: "no_data" };

/**
 * One chart per turn, drawn from kitchen-mcp data by fixed code: the model chooses what to
 * show, never the numbers (ADR 0015). The chart is sent after the text reply.
 */
export function createChartTool(ctx: ChartContext) {
  return createTool({
    name: CHART_TOOL_NAME,
    description:
      "Send the user one chart (a PNG after your reply) drawn from the outlet's waste and sales data. You choose the kind and the query; the numbers are read from the database. At most one per turn.",
    inputSchema: chartInput,
    async handler(args): Promise<Result> {
      if (ctx.turn.chart) return fail("only one chart per turn; one is already being sent");
      if (args.from > args.to) return fail("from must be on or before to");
      // Check the span by arithmetic before listing its days: any four-digit year is valid.
      const span = (Date.parse(args.to) - Date.parse(args.from)) / 86_400_000 + 1;
      if (span > MAX_CHART_DAYS) return fail(`a chart covers at most ${MAX_CHART_DAYS} days`);
      const days = daysBetween(args.from, args.to);
      const item = args.item_id ? ctx.menu.find((m) => m.id === args.item_id) : undefined;
      if (args.item_id && !item)
        return fail(`item_id ${args.item_id} is not on this outlet's menu`);
      const metric: Metric = args.metric ?? "waste_kg";
      const range = rangeLabel(args.from, args.to);
      const unit = UNIT_LABEL[metric];
      const filters = { from: args.from, to: args.to };

      let title: string;
      let spec: ChartSpec;
      if (args.kind === "waste_trend") {
        if (days.length < 2) return NO_DATA;
        const { groups } = await ctx.queryWaste({
          filters: {
            ...filters,
            ...(item ? { item_id: item.id } : {}),
            ...(args.cause ? { cause: args.cause } : {}),
          },
          group_by: "day",
        });
        if (groups.length === 0) return NO_DATA;
        const byDay = new Map(groups.map((g) => [g.date, g[metric]]));
        const what = [item?.name, args.cause ? CAUSE_LABELS[args.cause] : undefined]
          .filter(Boolean)
          .join(", ");
        title = `Limbah${what ? ` ${what}` : ""} per hari (${unit}), ${range}`;
        spec = trendSpec(
          title,
          metric,
          days.map((date) => ({ date, value: byDay.get(date) ?? 0 })),
        );
      } else if (args.kind === "waste_vs_sales") {
        if (!item) return fail("waste_vs_sales needs item_id");
        if (days.length < 2) return NO_DATA;
        const [{ groups }, { rows }] = await Promise.all([
          ctx.queryWaste({ filters: { ...filters, item_id: item.id }, group_by: "day" }),
          ctx.getSales({ ...filters, item_id: item.id }),
        ]);
        if (groups.length === 0 && rows.length === 0) return NO_DATA;
        const waste = new Map(groups.map((g) => [g.date, g.portions]));
        const sold = new Map<string, number>();
        for (const r of rows) sold.set(r.date, (sold.get(r.date) ?? 0) + r.qty_sold);
        title = `${item.name}: limbah vs terjual (porsi), ${range}`;
        spec = vsSalesSpec(title, [
          ...days.map((date) => ({
            date,
            series: "Limbah" as const,
            portions: waste.get(date) ?? 0,
          })),
          ...days.map((date) => ({
            date,
            series: "Terjual" as const,
            portions: sold.get(date) ?? 0,
          })),
        ]);
      } else {
        if (!args.by) return fail("waste_breakdown needs by: item or cause");
        const { groups } = await ctx.queryWaste({ filters, group_by: args.by });
        const bars: BreakdownBar[] = groups
          .map((g) => ({
            label:
              args.by === "item" ? (g.item_name ?? "?") : g.cause ? CAUSE_LABELS[g.cause] : "?",
            value: g[metric],
          }))
          .filter((b) => b.value > 0)
          .sort((a, b) => b.value - a.value)
          .slice(0, MAX_BARS);
        if (bars.length === 0) return NO_DATA;
        title = `Limbah per ${args.by === "item" ? "menu" : "penyebab"} (${unit}), ${range}`;
        spec = breakdownSpec(title, metric, bars);
      }

      try {
        ctx.turn.chart = { png: await ctx.renderer.render(spec), title };
      } catch (error) {
        ctx.log("Rendering a chart failed", error);
        return fail("the chart could not be drawn; answer in text only");
      }
      return { sent: true, title, note: "The chart is sent after your reply." };
    },
  });
}
