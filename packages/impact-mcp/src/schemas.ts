import { WASTE_CAUSES } from "@sisaku/db";
import * as z from "zod";

// Input and output schemas for every impact-mcp tool. The SDK validates inputs against these
// before a handler runs, and publishes them to clients as JSON Schema.

export const ESTIMATE_NOTE =
  "Estimate: global default factors (Our World in Data production factors per kg of raw product, IPCC landfill defaults), applied to cooked waste weight. Not a certified figure.";

const uuid = z.uuid();
const isoDate = z.iso.date();
const foodCategory = z.string().min(1).max(64);

// ---- inputs ----

export const getFactorInput = z.object({
  food_category: foodCategory.describe(
    "Food category of a menu item (food_category from get_menu)",
  ),
});

export const computeCo2eInput = z.object({
  filters: z
    .object({
      outlet_id: uuid,
      from: isoDate.describe("First local day of the outlet, inclusive (YYYY-MM-DD)"),
      to: isoDate.describe("Last local day of the outlet, inclusive (YYYY-MM-DD)"),
      item_id: uuid.optional(),
      cause: z.enum(WASTE_CAUSES).optional(),
    })
    .refine((v) => v.from <= v.to, { message: "from must be on or before to", path: ["to"] }),
});

export const findFoodbanksInput = z.object({
  outlet_id: uuid,
  location: z
    .string()
    .max(100)
    .optional()
    .describe("Area or city to search; defaults to the outlet's location. Empty returns all"),
});

export const pickupItem = z.object({
  item_id: uuid.describe("Menu item id from get_menu"),
  portion_count: z.number().int().positive().max(10000),
});

export const draftPickupInput = z.object({
  outlet_id: uuid,
  foodbank_id: z.string().min(1).max(64).describe("Food bank id from find_foodbanks"),
  items: z
    .array(pickupItem)
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.item_id)).size === items.length, {
      message: "Each item_id may appear only once",
    }),
});

export const submitPickupInput = z.object({
  outlet_id: uuid,
  id: uuid.describe("Pickup request id from draft_pickup"),
});

// ---- outputs ----

export const factorOutput = z.object({
  food_category: z.string(),
  production_kg_co2e_per_kg: z.number(),
  landfill_kg_co2e_per_kg: z.number(),
  total_kg_co2e_per_kg: z.number(),
  source: z.string(),
});

const co2e = {
  waste_kg: z.number(),
  entries: z.number(),
  production_kg_co2e: z.number(),
  landfill_kg_co2e: z.number(),
  total_kg_co2e: z.number(),
};

export const computeCo2eOutput = z.object({
  outlet_id: uuid,
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  totals: z
    .object(co2e)
    .describe(
      "waste_kg and entries include uncovered waste; CO2e covers only categories with a factor",
    ),
  by_category: z.array(z.object({ food_category: z.string(), ...co2e, source: z.string() })),
  uncovered: z
    .array(z.object({ food_category: z.string(), waste_kg: z.number(), entries: z.number() }))
    .describe("Waste whose food category has no emission factor; left out of CO2e"),
  note: z.string(),
});

const foodbank = z.object({
  id: z.string(),
  name: z.string(),
  area: z.string(),
  capacity_note: z.string(),
});

export const findFoodbanksOutput = z.object({
  location: z.string().nullable().describe("The location searched; null means all were returned"),
  foodbanks: z.array(foodbank),
});

export const pickupOutput = z.object({
  id: uuid,
  outlet_id: uuid,
  foodbank_id: z.string(),
  items: z.array(pickupItem),
  status: z.enum(["draft", "pending", "approved", "rejected", "submitted"]),
  created_at: z.string().describe("ISO 8601, UTC"),
  approved_by: z.string().nullable(),
});

export const pickupResult = z.object({ pickup: pickupOutput });

export type GetFactorInput = z.infer<typeof getFactorInput>;
export type FactorOutput = z.infer<typeof factorOutput>;
export type ComputeCo2eInput = z.infer<typeof computeCo2eInput>;
export type ComputeCo2eOutput = z.infer<typeof computeCo2eOutput>;
export type FindFoodbanksInput = z.infer<typeof findFoodbanksInput>;
export type FindFoodbanksOutput = z.infer<typeof findFoodbanksOutput>;
export type DraftPickupInput = z.infer<typeof draftPickupInput>;
export type SubmitPickupInput = z.infer<typeof submitPickupInput>;
export type Pickup = z.infer<typeof pickupOutput>;
