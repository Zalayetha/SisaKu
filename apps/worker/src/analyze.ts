import { callMcpTool } from "@sisaku/agents";
import type {
  GetSalesInput,
  GetSalesOutput,
  QueryWasteInput,
  QueryWasteOutput,
} from "@sisaku/kitchen-mcp";
import * as z from "zod";
import type { StepDefinition } from "./steps";

/** Days before the business date that an item's daily average looks at. */
export const SPIKE_WINDOW_DAYS = 14;
/** Fewer days with a sales record in the window than this, and nothing is flagged. */
export const MIN_DAYS_COUNTED = 7;
/** A waste spike is more than this many times the item's daily average... */
export const SPIKE_RATIO = 2;
/** ...and at least this many kg. */
export const MIN_SPIKE_KG = 1;

const kg = z.number().nonnegative();
const totals = {
  waste_kg: kg,
  portions: z.number().nonnegative(),
  cost_idr: z.number().nonnegative(),
};

export const spikeExplanation = z.object({
  kind: z.enum(["sales_drop", "over_prep", "spoilage", "unexplained"]),
  /** One short English sentence with the numbers read. Left out when unexplained. */
  evidence: z.string().optional(),
});

export const wasteSpike = z.object({
  item_id: z.string(),
  item_name: z.string(),
  waste_kg: kg,
  average_kg: kg,
  days_counted: z.number().int().positive(),
  investigated: z.boolean(),
  explanation: spikeExplanation,
});

/** The business date's waste, and its waste spikes, largest first (ADR 0018). */
export const analyzeOutput = z.object({
  waste_by_item: z.array(z.object({ item_id: z.string(), item_name: z.string(), ...totals })),
  waste_by_cause: z.array(z.object({ cause: z.string(), ...totals })),
  spikes: z.array(wasteSpike),
});

export type SpikeExplanation = z.infer<typeof spikeExplanation>;
export type WasteSpike = z.infer<typeof wasteSpike>;
export type AnalyzeOutput = z.infer<typeof analyzeOutput>;

/** The day `offset` days from `date` (YYYY-MM-DD). */
function addDays(date: string, offset: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Waste is stored to the gram, so whole grams compare exactly where kg floats would not. */
const grams = (kg: number) => Math.round(kg * 1000);

function totalsOf(group: QueryWasteOutput["groups"][number]) {
  return { waste_kg: group.waste_kg, portions: group.portions, cost_idr: group.cost_idr };
}

/**
 * Reads the business date's waste through kitchen-mcp and flags waste spikes from fixed code, with
 * no LLM (ADR 0018). No spike is explained yet.
 */
export const analyzeStep: StepDefinition<AnalyzeOutput> = {
  name: "analyze",
  output: analyzeOutput,
  async run({ run, servers }) {
    const outlet_id = run.outletId;
    const date = run.businessDate;
    const wasteOn = (group_by: "item" | "cause") =>
      callMcpTool<QueryWasteOutput>(servers, "query_waste", {
        filters: { outlet_id, from: date, to: date },
        group_by,
      } satisfies QueryWasteInput);
    const [byItem, byCause] = await Promise.all([wasteOn("item"), wasteOn("cause")]);

    const waste_by_item = byItem.groups.map((g) => ({
      item_id: g.item_id!,
      item_name: g.item_name!,
      ...totalsOf(g),
    }));
    const waste_by_cause = byCause.groups.map((g) => ({ cause: g.cause!, ...totalsOf(g) }));
    const noSpikes = { waste_by_item, waste_by_cause, spikes: [] };
    if (waste_by_item.length === 0) return noSpikes;

    // Only days with a sales record count toward an item's average: a closed or unlogged day is
    // not a day without waste.
    const from = addDays(date, -SPIKE_WINDOW_DAYS);
    const to = addDays(date, -1);
    const sold = await callMcpTool<GetSalesOutput>(servers, "get_sales", {
      outlet_id,
      from,
      to,
    } satisfies GetSalesInput);
    const salesDays = new Set(sold.rows.map((r) => r.date));
    if (salesDays.size < MIN_DAYS_COUNTED) return noSpikes;

    // A candidate needs at least the floor on the business date, so only those are read further.
    const candidates = waste_by_item.filter((item) => item.waste_kg >= MIN_SPIKE_KG);
    const spikes = await Promise.all(
      candidates.map(async (item): Promise<WasteSpike | undefined> => {
        const history = await callMcpTool<QueryWasteOutput>(servers, "query_waste", {
          filters: { outlet_id, from, to, item_id: item.item_id },
          group_by: "day",
        } satisfies QueryWasteInput);
        const totalGrams = history.groups
          .filter((g) => salesDays.has(g.date!))
          .reduce((sum, g) => sum + grams(g.waste_kg), 0);
        // waste > ratio × (total / days), multiplied through by days to stay in whole grams.
        if (grams(item.waste_kg) * salesDays.size <= SPIKE_RATIO * totalGrams) return undefined;
        return {
          item_id: item.item_id,
          item_name: item.item_name,
          waste_kg: item.waste_kg,
          average_kg: Math.round(totalGrams / salesDays.size) / 1000,
          days_counted: salesDays.size,
          investigated: false,
          explanation: { kind: "unexplained" },
        };
      }),
    );

    return {
      waste_by_item,
      waste_by_cause,
      // query_waste already orders by kg; sorting here keeps the order from depending on it.
      spikes: spikes.filter((spike) => spike !== undefined).sort((a, b) => b.waste_kg - a.waste_kg),
    };
  },
};
