import { callMcpTool } from "@sisaku/agents";
import type {
  GetMenuInput,
  GetMenuOutput,
  GetPrepLogInput,
  GetPrepLogOutput,
  GetSalesInput,
  GetSalesOutput,
  QueryWasteInput,
  QueryWasteOutput,
} from "@sisaku/kitchen-mcp";
import * as z from "zod";
import type { StepDefinition } from "./steps";

const count = z.number().int().nonnegative();
/** Items with at least one portion, and their portions together. */
const quantity = z.object({ items: count, portions: count });

export const ingestGap = z.discriminatedUnion("type", [
  /** No sales record for the day. A record of zero portions is not a gap. */
  z.object({ type: z.literal("no_sales") }),
  z.object({ type: z.literal("no_prep_log") }),
  z.object({ type: z.literal("no_waste_logged") }),
  /** Left out when the whole prep log is missing: `no_prep_log` says it once. */
  z.object({
    type: z.literal("sold_not_prepped"),
    item_id: z.string(),
    item_name: z.string(),
  }),
]);

/** The business date's totals. Later steps read the details through the MCP tools. */
export const ingestOutput = z.object({
  items_on_menu: count,
  sales: quantity,
  prep: quantity,
  waste: z.object({ entries: count, weight_kg: z.number().nonnegative() }),
  gaps: z.array(ingestGap),
});

export type IngestGap = z.infer<typeof ingestGap>;
export type IngestOutput = z.infer<typeof ingestOutput>;

function total(quantities: readonly number[]) {
  return {
    items: quantities.filter((quantity) => quantity > 0).length,
    portions: quantities.reduce((sum, quantity) => sum + quantity, 0),
  };
}

/**
 * Reads the day through kitchen-mcp from fixed code, without an LLM (ADR 0017). A gap in the data
 * never fails the step; a failed read does.
 */
export const ingestStep: StepDefinition<IngestOutput> = {
  name: "ingest",
  output: ingestOutput,
  async run({ run, servers }) {
    const outlet_id = run.outletId;
    const date = run.businessDate;
    const day = { from: date, to: date };
    const [menu, sold, prepped, waste] = await Promise.all([
      callMcpTool<GetMenuOutput>(servers, "get_menu", { outlet_id } satisfies GetMenuInput),
      callMcpTool<GetSalesOutput>(servers, "get_sales", {
        outlet_id,
        ...day,
      } satisfies GetSalesInput),
      callMcpTool<GetPrepLogOutput>(servers, "get_prep_log", {
        outlet_id,
        date,
      } satisfies GetPrepLogInput),
      callMcpTool<QueryWasteOutput>(servers, "query_waste", {
        filters: { outlet_id, ...day },
        group_by: "none",
      } satisfies QueryWasteInput),
    ]);
    // No group at all when nothing was logged.
    const wasteTotal = waste.groups[0] ?? { entries: 0, waste_kg: 0 };

    const gaps: IngestGap[] = [];
    if (sold.rows.length === 0) gaps.push({ type: "no_sales" });
    if (prepped.rows.length === 0) gaps.push({ type: "no_prep_log" });
    if (wasteTotal.entries === 0) gaps.push({ type: "no_waste_logged" });
    if (prepped.rows.length > 0) {
      const preppedIds = new Set(
        prepped.rows.filter((r) => r.qty_prepped > 0).map((r) => r.item_id),
      );
      for (const { item_id, item_name, qty_sold } of sold.rows) {
        if (qty_sold > 0 && !preppedIds.has(item_id)) {
          gaps.push({ type: "sold_not_prepped", item_id, item_name });
        }
      }
    }

    return {
      items_on_menu: menu.items.length,
      sales: total(sold.rows.map((r) => r.qty_sold)),
      prep: total(prepped.rows.map((r) => r.qty_prepped)),
      waste: { entries: wasteTotal.entries, weight_kg: wasteTotal.waste_kg },
      gaps,
    };
  },
};
