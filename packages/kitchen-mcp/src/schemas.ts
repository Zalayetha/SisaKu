import { MAX_WASTE_WEIGHT_KG, WASTE_CAUSES } from "@sisaku/db";
import * as z from "zod";

// Input and output schemas for every kitchen-mcp tool. The SDK validates inputs against these
// before a handler runs, and publishes them to clients as JSON Schema.

/** Longest range get_sales accepts, in days (inclusive). Keeps raw rows out of an LLM's context. */
export const MAX_SALES_RANGE_DAYS = 92;

const uuid = z.uuid();
const isoDate = z.iso.date();
const cause = z.enum(WASTE_CAUSES);
const weightKg = z.number().positive().max(MAX_WASTE_WEIGHT_KG);
const portionCount = z.number().int().positive().max(10000);

const photoPath = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes(":") &&
      p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
    {
      message:
        'photo_path must be a relative path inside the photo volume, e.g. "<outlet_id>/<uuid>.jpg" (no leading "/", no "..", no URL)',
    },
  );

// ---- inputs ----

export const getSalesInput = z
  .object({
    outlet_id: uuid,
    from: isoDate.describe("First day, inclusive (YYYY-MM-DD)"),
    to: isoDate.describe(`Last day, inclusive (YYYY-MM-DD); at most ${MAX_SALES_RANGE_DAYS} days`),
    item_id: uuid.optional().describe("Only this menu item (its id)"),
  })
  .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["to"] });

export const getMenuInput = z.object({ outlet_id: uuid });

export const getPrepLogInput = z.object({
  outlet_id: uuid,
  date: isoDate.describe("Day of the prep log (YYYY-MM-DD)"),
});

/** Most lines one log_waste call takes: a waste guess has up to five (ADR 0014). */
export const MAX_WASTE_LINES = 5;

const wasteLine = z
  .object({
    item_id: uuid.describe("Menu item id"),
    portion_count: portionCount
      .optional()
      .describe("Portions wasted; the server converts to kg with the item's portion weight"),
    weight_kg: weightKg.optional().describe("Weight wasted in kg, when staff typed a weight"),
  })
  .refine((v) => (v.portion_count === undefined) !== (v.weight_kg === undefined), {
    message: "Give exactly one of portion_count or weight_kg",
  });

export const logWasteInput = z.object({
  outlet_id: uuid,
  lines: z
    .array(wasteLine)
    .min(1)
    .max(MAX_WASTE_LINES)
    .describe("One entry per line; all are saved together, or none if any line is rejected"),
  cause,
  source: z.enum(["photo", "text"]).describe("How staff reported it"),
  photo_path: photoPath
    .optional()
    .describe("Relative path of the saved photo inside the photo volume"),
  confidence: z.number().min(0).max(1).optional().describe("Vision model confidence, 0 to 1"),
  confirmed_by: uuid.optional().describe("users.id of the staff member who confirmed the entry"),
  run_id: uuid.optional().describe("agent_runs.id of the Copilot turn that logged the entry"),
  logged_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When the waste happened (ISO 8601 with offset); defaults to now"),
});

export const queryWasteInput = z.object({
  filters: z
    .object({
      outlet_id: uuid,
      from: isoDate.describe("First local day of the outlet, inclusive (YYYY-MM-DD)"),
      to: isoDate.describe("Last local day of the outlet, inclusive (YYYY-MM-DD)"),
      item_id: uuid.optional(),
      cause: cause.optional(),
    })
    .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["to"] }),
  group_by: z
    .enum(["item", "cause", "day", "none"])
    .describe('How to group the totals; "none" returns one total row'),
});

export const updateEntryInput = z.object({
  outlet_id: uuid,
  id: uuid.describe("Waste entry id"),
  patch: z
    .object({
      item_id: uuid.optional(),
      cause: cause.optional(),
      logged_at: z.iso.datetime({ offset: true }).optional(),
      portion_count: portionCount.optional(),
      weight_kg: weightKg.optional(),
    })
    .refine((p) => Object.values(p).some((v) => v !== undefined), {
      message: "patch must change at least one field",
    })
    .refine((p) => p.portion_count === undefined || p.weight_kg === undefined, {
      message: "Give at most one of portion_count or weight_kg",
    }),
});

// ---- outputs ----

const menuItem = z.object({
  id: uuid,
  name: z.string(),
  category: z.string(),
  cost_per_portion: z.number().describe("Rupiah"),
  portion_weight_kg: z.number(),
  food_category: z.string(),
});

const wasteEntry = z.object({
  id: uuid,
  outlet_id: uuid,
  item_id: uuid,
  item_name: z.string(),
  logged_at: z.string().describe("ISO 8601, UTC"),
  weight_kg: z.number(),
  portion_count: z.number().nullable(),
  cause: z.string(),
  source: z.enum(["photo", "text"]),
  photo_path: z.string().nullable(),
  confidence: z.number().nullable(),
  confirmed_by: z.string().nullable(),
  run_id: z.string().nullable().describe("agent_runs.id of the turn that logged it, if any"),
});

export const getSalesOutput = z.object({
  outlet_id: uuid,
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({ date: z.string(), item_id: uuid, item_name: z.string(), qty_sold: z.number() }),
  ),
});

export const getMenuOutput = z.object({ outlet_id: uuid, items: z.array(menuItem) });

export const getPrepLogOutput = z.object({
  outlet_id: uuid,
  date: z.string(),
  rows: z.array(z.object({ item_id: uuid, item_name: z.string(), qty_prepped: z.number() })),
});

export const logWasteOutput = z.object({ entries: z.array(wasteEntry) });

export const queryWasteOutput = z.object({
  outlet_id: uuid,
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  group_by: z.enum(["item", "cause", "day", "none"]),
  groups: z.array(
    z.object({
      item_id: uuid.optional(),
      item_name: z.string().optional(),
      cause: z.string().optional(),
      date: z.string().optional(),
      waste_kg: z.number(),
      entries: z.number(),
      portions: z
        .number()
        .describe(
          "Estimated: waste_kg / portion weight (items without a portion weight count as 0)",
        ),
      cost_idr: z
        .number()
        .describe(
          "Estimated Rupiah: portions x cost per portion (0 for items without a portion weight)",
        ),
    }),
  ),
});

export const updateEntryOutput = z.object({ before: wasteEntry, after: wasteEntry });

export type GetSalesInput = z.infer<typeof getSalesInput>;
export type GetMenuInput = z.infer<typeof getMenuInput>;
export type GetPrepLogInput = z.infer<typeof getPrepLogInput>;
export type LogWasteInput = z.infer<typeof logWasteInput>;
export type QueryWasteInput = z.infer<typeof queryWasteInput>;
export type UpdateEntryInput = z.infer<typeof updateEntryInput>;
export type WasteEntry = z.infer<typeof wasteEntry>;
export type GetSalesOutput = z.infer<typeof getSalesOutput>;
export type GetMenuOutput = z.infer<typeof getMenuOutput>;
export type GetPrepLogOutput = z.infer<typeof getPrepLogOutput>;
export type QueryWasteOutput = z.infer<typeof queryWasteOutput>;
