import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  emissionFactors,
  menuItems,
  outlets,
  pickupRequests,
  users,
  wasteEntries,
  type createDb,
} from "@sisaku/db";
import { findFoodBank, matchFoodBanks } from "./foodbanks";
import {
  ESTIMATE_NOTE,
  type ComputeCo2eInput,
  type ComputeCo2eOutput,
  type DraftPickupInput,
  type FactorOutput,
  type FindFoodbanksInput,
  type FindFoodbanksOutput,
  type GetFactorInput,
  type Pickup,
  type SubmitPickupInput,
} from "./schemas";

export type Db = ReturnType<typeof createDb>["db"];

/** An error the caller can fix (unknown outlet, unapproved pickup, ...). Its message is shown to the client. */
export class ImpactError extends Error {
  override name = "ImpactError";
}

/** Roles allowed to approve a pickup request. */
const APPROVER_ROLES = ["manager", "owner"] as const;

async function requireOutlet(db: Db, outletId: string) {
  const [o] = await db
    .select({ id: outlets.id, timezone: outlets.timezone, location: outlets.location })
    .from(outlets)
    .where(eq(outlets.id, outletId));
  if (!o) throw new ImpactError(`Unknown outlet ${outletId}`);
  return o;
}

export async function getFactor(db: Db, { food_category }: GetFactorInput): Promise<FactorOutput> {
  const [f] = await db
    .select()
    .from(emissionFactors)
    .where(eq(emissionFactors.foodCategory, food_category));
  if (!f) throw new ImpactError(`No emission factor for food category "${food_category}"`);
  return {
    food_category: f.foodCategory,
    production_kg_co2e_per_kg: f.productionKgCo2ePerKg,
    landfill_kg_co2e_per_kg: f.landfillKgCo2ePerKg,
    total_kg_co2e_per_kg: Math.round((f.productionKgCo2ePerKg + f.landfillKgCo2ePerKg) * 1e6) / 1e6,
    source: f.source,
  };
}

/**
 * CO2e of an outlet's logged waste, computed in SQL: waste kg x (production + landfill factor)
 * of the item's food category. Waste whose category has no factor counts toward waste_kg and
 * is listed under `uncovered`, but adds no CO2e.
 */
export async function computeCo2e(
  db: Db,
  { filters }: ComputeCo2eInput,
): Promise<ComputeCo2eOutput> {
  const outlet = await requireOutlet(db, filters.outlet_id);
  const tz = outlet.timezone;
  if (filters.item_id) {
    const [i] = await db
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.id, filters.item_id), eq(menuItems.outletId, filters.outlet_id)));
    if (!i)
      throw new ImpactError(
        `Item ${filters.item_id} is not on the menu of outlet ${filters.outlet_id}`,
      );
  }

  // Outlet-local days, as in kitchen-mcp's query_waste: [from 00:00, to + 1 day 00:00).
  const where: SQL[] = [
    eq(wasteEntries.outletId, filters.outlet_id),
    sql`${wasteEntries.loggedAt} >= (${filters.from}::date)::timestamp at time zone ${tz}`,
    sql`${wasteEntries.loggedAt} < ((${filters.to}::date) + 1)::timestamp at time zone ${tz}`,
  ];
  if (filters.item_id) where.push(eq(wasteEntries.itemId, filters.item_id));
  if (filters.cause) where.push(eq(wasteEntries.cause, filters.cause));

  // kg CO2e rounded to 2 decimals; null factors (uncovered) add nothing to the sums.
  const kgCo2e = (factor: SQL) =>
    sql<string>`coalesce(round(sum(${wasteEntries.weightKg} * ${factor})::numeric, 2), 0)`;
  const sums = {
    waste_kg: sql<string>`round(sum(${wasteEntries.weightKg}), 3)`,
    entries: sql<number>`count(*)::int`,
    production_kg_co2e: kgCo2e(sql`${emissionFactors.productionKgCo2ePerKg}`),
    landfill_kg_co2e: kgCo2e(sql`${emissionFactors.landfillKgCo2ePerKg}`),
    total_kg_co2e: kgCo2e(
      sql`(${emissionFactors.productionKgCo2ePerKg} + ${emissionFactors.landfillKgCo2ePerKg})`,
    ),
  };
  const itemJoin = eq(menuItems.id, wasteEntries.itemId);
  const factorJoin = eq(emissionFactors.foodCategory, menuItems.foodCategory);
  const groups = await db
    .select({ food_category: menuItems.foodCategory, source: emissionFactors.source, ...sums })
    .from(wasteEntries)
    .innerJoin(menuItems, itemJoin)
    .leftJoin(emissionFactors, factorJoin)
    .where(and(...where))
    .groupBy(menuItems.foodCategory, emissionFactors.foodCategory, emissionFactors.source)
    .orderBy(sql`sum(${wasteEntries.weightKg}) desc`, asc(menuItems.foodCategory));
  const [t] = await db
    .select(sums)
    .from(wasteEntries)
    .innerJoin(menuItems, itemJoin)
    .leftJoin(emissionFactors, factorJoin)
    .where(and(...where));

  // An aggregate with no matching rows returns one row with a null waste_kg.
  const num = (r: { waste_kg: string | null; entries: number }) => ({
    waste_kg: Number(r.waste_kg ?? 0),
    entries: Number(r.entries),
  });
  const co2e = (r: {
    production_kg_co2e: string;
    landfill_kg_co2e: string;
    total_kg_co2e: string;
  }) => ({
    production_kg_co2e: Number(r.production_kg_co2e),
    landfill_kg_co2e: Number(r.landfill_kg_co2e),
    total_kg_co2e: Number(r.total_kg_co2e),
  });

  return {
    outlet_id: filters.outlet_id,
    from: filters.from,
    to: filters.to,
    timezone: tz,
    totals: { ...num(t!), ...co2e(t!) },
    by_category: groups
      .filter((g) => g.source !== null)
      .map((g) => ({ food_category: g.food_category, ...num(g), ...co2e(g), source: g.source! })),
    uncovered: groups
      .filter((g) => g.source === null)
      .map((g) => ({ food_category: g.food_category, ...num(g) })),
    note: ESTIMATE_NOTE,
  };
}

export async function findFoodbanks(
  db: Db,
  input: FindFoodbanksInput,
): Promise<FindFoodbanksOutput> {
  const outlet = await requireOutlet(db, input.outlet_id);
  const location = (input.location ?? outlet.location ?? "").trim() || null;
  return { location, foodbanks: matchFoodBanks(location) };
}

type PickupRow = typeof pickupRequests.$inferSelect;
const toPickup = (r: PickupRow): Pickup => ({
  id: r.id,
  outlet_id: r.outletId,
  foodbank_id: r.foodbankId,
  items: r.items as Pickup["items"],
  status: r.status,
  created_at: r.createdAt.toISOString(),
  approved_by: r.approvedBy,
});

/** Records a pickup request waiting for approval (status pending). Approval happens outside this server. */
export async function draftPickup(db: Db, input: DraftPickupInput): Promise<{ pickup: Pickup }> {
  await requireOutlet(db, input.outlet_id);
  if (!findFoodBank(input.foodbank_id))
    throw new ImpactError(`Unknown food bank ${input.foodbank_id}; use an id from find_foodbanks`);
  const ids = input.items.map((i) => i.item_id);
  const found = new Set(
    (
      await db
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(and(inArray(menuItems.id, ids), eq(menuItems.outletId, input.outlet_id)))
    ).map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length)
    throw new ImpactError(`Not on the menu of outlet ${input.outlet_id}: ${missing.join(", ")}`);
  const [row] = await db
    .insert(pickupRequests)
    .values({
      outletId: input.outlet_id,
      foodbankId: input.foodbank_id,
      items: input.items.map(({ item_id, portion_count }) => ({ item_id, portion_count })),
      status: "pending",
    })
    .returning();
  return { pickup: toPickup(row!) };
}

/**
 * Records that an approved pickup request was submitted. The approval check and the update are
 * one statement, so a request cannot be submitted twice or change status in between.
 */
export async function submitPickup(
  db: Db,
  { outlet_id, id }: SubmitPickupInput,
): Promise<{ pickup: Pickup }> {
  await requireOutlet(db, outlet_id);
  const approvers = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.outletId, outlet_id), inArray(users.role, [...APPROVER_ROLES])));
  const [done] = await db
    .update(pickupRequests)
    .set({ status: "submitted" })
    .where(
      and(
        eq(pickupRequests.id, id),
        eq(pickupRequests.outletId, outlet_id),
        eq(pickupRequests.status, "approved"),
        isNotNull(pickupRequests.approvedBy),
        inArray(pickupRequests.approvedBy, approvers),
      ),
    )
    .returning();
  if (done) return { pickup: toPickup(done) };

  // Refused: explain why, without revealing requests of other outlets.
  const [cur] = await db
    .select()
    .from(pickupRequests)
    .where(and(eq(pickupRequests.id, id), eq(pickupRequests.outletId, outlet_id)));
  if (!cur) throw new ImpactError(`Unknown pickup request ${id} for outlet ${outlet_id}`);
  const refuse = (why: string) =>
    new ImpactError(`Pickup request ${id} cannot be submitted: ${why}`);
  if (cur.status === "submitted") throw refuse("it was already submitted");
  if (cur.status !== "approved")
    throw refuse(`it is ${cur.status}; a manager or owner must approve it first`);
  if (!cur.approvedBy) throw refuse("it is marked approved but has no approver");
  throw refuse("it was approved by someone who is not a manager or owner of this outlet");
}
