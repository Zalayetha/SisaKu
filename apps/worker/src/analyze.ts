import type { CompletionModel } from "@anvia/core";
import { callMcpTool, investigateSpike, spikeExplanation, UNEXPLAINED } from "@sisaku/agents";
import type {
  GetSalesInput,
  GetSalesOutput,
  QueryWasteInput,
  QueryWasteOutput,
} from "@sisaku/kitchen-mcp";
import * as z from "zod";
import type { StepContext, StepDefinition } from "./steps";

/** Days before the business date that an item's daily average looks at. */
export const SPIKE_WINDOW_DAYS = 14;
/** Fewer days with a sales record for the item in the window than this, and it is not flagged. */
export const MIN_DAYS_COUNTED = 7;
/** A waste spike is more than this many times the item's daily average... */
export const SPIKE_RATIO = 2;
/** ...and at least this many kg. */
export const MIN_SPIKE_KG = 1;
/**
 * Spikes investigated a night, largest first; the others stay unexplained. They run one after
 * another within the step's default 5-minute limit (spec #89): at worst 3 runs of up to 7 model
 * requests each, 21 in a row. An attempt past the limit is retried from the start.
 */
export const MAX_INVESTIGATIONS = 3;

const kg = z.number().nonnegative();
const totals = {
  waste_kg: kg,
  portions: z.number().nonnegative(),
  cost_idr: z.number().nonnegative(),
};

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
 * no LLM (ADR 0018). Every spike is left uninvestigated and unexplained.
 */
async function findSpikes({ run, servers }: StepContext): Promise<AnalyzeOutput> {
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

  // A candidate needs at least the floor on the business date, so only those are read further.
  const candidates = waste_by_item.filter((item) => item.waste_kg >= MIN_SPIKE_KG);
  if (candidates.length === 0) return noSpikes;

  // Only days with a sales record for the item count toward its average: a day it was not on
  // sale (closed, unlogged, or before it joined the menu) is not a day without waste.
  const from = addDays(date, -SPIKE_WINDOW_DAYS);
  const to = addDays(date, -1);
  const sold = await callMcpTool<GetSalesOutput>(servers, "get_sales", {
    outlet_id,
    from,
    to,
  } satisfies GetSalesInput);
  const salesDaysOf = (itemId: string) =>
    new Set(sold.rows.filter((r) => r.item_id === itemId).map((r) => r.date));

  const spikes = await Promise.all(
    candidates.map(async (item): Promise<WasteSpike | undefined> => {
      const salesDays = salesDaysOf(item.item_id);
      if (salesDays.size < MIN_DAYS_COUNTED) return undefined;
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
        explanation: UNEXPLAINED,
      };
    }),
  );

  return {
    waste_by_item,
    waste_by_cause,
    // query_waste already orders by kg; sorting here keeps the order from depending on it.
    spikes: spikes.filter((spike) => spike !== undefined).sort((a, b) => b.waste_kg - a.waste_kg),
  };
}

/**
 * The Analyze step: flags waste spikes from fixed code, then has the spike investigator explain
 * the largest few, one run after another (ADR 0018). A failed investigation fails the attempt.
 */
export function createAnalyzeStep({
  model,
}: {
  model: CompletionModel;
}): StepDefinition<AnalyzeOutput> {
  return {
    name: "analyze",
    output: analyzeOutput,
    async run(context) {
      const found = await findSpikes(context);
      const spikes: WasteSpike[] = [];
      for (const [i, spike] of found.spikes.entries()) {
        if (i >= MAX_INVESTIGATIONS) {
          spikes.push(spike);
          continue;
        }
        const explanation = await investigateSpike({
          model,
          servers: context.servers,
          outletId: context.run.outletId,
          timezone: context.run.timezone,
          spike: { ...spike, business_date: context.run.businessDate },
          trace: context.trace,
          observability: context.observability,
          abortSignal: context.signal,
        });
        spikes.push({ ...spike, investigated: true, explanation });
      }
      return { ...found, spikes };
    },
  };
}
