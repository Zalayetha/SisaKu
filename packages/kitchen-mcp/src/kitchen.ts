import { and, asc, between, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  agentRuns,
  MAX_WASTE_WEIGHT_KG,
  menuItems,
  outlets,
  prepLogs,
  sales,
  users,
  wasteEntries,
  type createDb,
} from "@sisaku/db";
import {
  MAX_LISTED_ENTRIES,
  MAX_SALES_RANGE_DAYS,
  type GetMenuInput,
  type GetMenuOutput,
  type GetPrepLogInput,
  type GetPrepLogOutput,
  type GetSalesInput,
  type GetSalesOutput,
  type ListEntriesInput,
  type ListEntriesOutput,
  type LogWasteInput,
  type QueryWasteInput,
  type WasteFilters,
  type QueryWasteOutput,
  type UpdateEntryInput,
  type WasteEntry,
} from "./schemas";

export type Db = ReturnType<typeof createDb>["db"];

/** An error the caller can fix (unknown outlet, item from another outlet, ...). Its message is shown to the client. */
export class KitchenError extends Error {
  override name = "KitchenError";
}

/** How far in the future logged_at may be, to allow for clock skew. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

const days = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;

async function requireOutlet(db: Db, outletId: string) {
  const [o] = await db
    .select({ id: outlets.id, timezone: outlets.timezone })
    .from(outlets)
    .where(eq(outlets.id, outletId));
  if (!o) throw new KitchenError(`Unknown outlet ${outletId}`);
  return o;
}

async function requireItem(db: Db, outletId: string, itemId: string) {
  const [i] = await db
    .select({ id: menuItems.id, portionWeightKg: menuItems.portionWeightKg })
    .from(menuItems)
    .where(and(eq(menuItems.id, itemId), eq(menuItems.outletId, outletId)));
  if (!i) throw new KitchenError(`Item ${itemId} is not on the menu of outlet ${outletId}`);
  return { id: i.id, portionWeightKg: Number(i.portionWeightKg) };
}

async function requireUser(db: Db, outletId: string, userId: string) {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.outletId, outletId)));
  if (!u) throw new KitchenError(`User ${userId} does not belong to outlet ${outletId}`);
}

function checkLoggedAt(loggedAt: string) {
  const at = new Date(loggedAt);
  if (at.getTime() > Date.now() + FUTURE_TOLERANCE_MS)
    throw new KitchenError(`logged_at ${loggedAt} is in the future`);
  return at;
}

function portionsToKg(portions: number, item: { id: string; portionWeightKg: number }) {
  // Migration 0002 rejects a 0 portion weight; this guards a database that has not run it yet.
  if (item.portionWeightKg <= 0)
    throw new KitchenError(
      `Item ${item.id} has no portion weight, so portions cannot be converted to kg; log weight_kg instead`,
    );
  const kg = round(portions * item.portionWeightKg, 3);
  if (kg > MAX_WASTE_WEIGHT_KG)
    throw new KitchenError(
      `${portions} portions is ${kg} kg, above the ${MAX_WASTE_WEIGHT_KG} kg limit`,
    );
  return kg;
}

async function requireRun(db: Db, runId: string) {
  const [r] = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, runId));
  if (!r) throw new KitchenError(`Unknown agent run ${runId}`);
}

async function getEntry(db: Db, outletId: string, id: string): Promise<WasteEntry> {
  const [e] = await db
    .select({
      id: wasteEntries.id,
      outletId: wasteEntries.outletId,
      itemId: wasteEntries.itemId,
      itemName: menuItems.name,
      loggedAt: wasteEntries.loggedAt,
      weightKg: wasteEntries.weightKg,
      portionCount: wasteEntries.portionCount,
      cause: wasteEntries.cause,
      source: wasteEntries.source,
      photoPath: wasteEntries.photoPath,
      confidence: wasteEntries.confidence,
      confirmedBy: wasteEntries.confirmedBy,
      runId: wasteEntries.runId,
    })
    .from(wasteEntries)
    .innerJoin(menuItems, eq(menuItems.id, wasteEntries.itemId))
    .where(and(eq(wasteEntries.id, id), eq(wasteEntries.outletId, outletId)));
  if (!e) throw new KitchenError(`Waste entry ${id} not found for outlet ${outletId}`);
  return {
    id: e.id,
    outlet_id: e.outletId,
    item_id: e.itemId,
    item_name: e.itemName,
    logged_at: e.loggedAt.toISOString(),
    weight_kg: Number(e.weightKg),
    portion_count: e.portionCount,
    cause: e.cause,
    source: e.source,
    photo_path: e.photoPath,
    confidence: e.confidence,
    confirmed_by: e.confirmedBy,
    run_id: e.runId,
  };
}

export async function getSales(db: Db, input: GetSalesInput): Promise<GetSalesOutput> {
  const n = days(input.from, input.to);
  if (n > MAX_SALES_RANGE_DAYS)
    throw new KitchenError(
      `Range is ${n} days; get_sales accepts at most ${MAX_SALES_RANGE_DAYS}. Split the request.`,
    );
  await requireOutlet(db, input.outlet_id);
  const where = [eq(sales.outletId, input.outlet_id), between(sales.date, input.from, input.to)];
  if (input.item_id) {
    await requireItem(db, input.outlet_id, input.item_id);
    where.push(eq(sales.itemId, input.item_id));
  }
  const rows = await db
    .select({
      date: sales.date,
      item_id: sales.itemId,
      item_name: menuItems.name,
      qty_sold: sales.qtySold,
    })
    .from(sales)
    .innerJoin(menuItems, eq(menuItems.id, sales.itemId))
    .where(and(...where))
    .orderBy(asc(sales.date), asc(menuItems.name));
  return { outlet_id: input.outlet_id, from: input.from, to: input.to, rows };
}

export async function getMenu(db: Db, input: GetMenuInput): Promise<GetMenuOutput> {
  await requireOutlet(db, input.outlet_id);
  const rows = await db
    .select()
    .from(menuItems)
    .where(eq(menuItems.outletId, input.outlet_id))
    .orderBy(asc(menuItems.category), asc(menuItems.name));
  return {
    outlet_id: input.outlet_id,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      cost_per_portion: Number(r.costPerPortion),
      portion_weight_kg: Number(r.portionWeightKg),
      food_category: r.foodCategory,
    })),
  };
}

export async function getPrepLog(db: Db, input: GetPrepLogInput): Promise<GetPrepLogOutput> {
  await requireOutlet(db, input.outlet_id);
  const rows = await db
    .select({
      item_id: prepLogs.itemId,
      item_name: menuItems.name,
      qty_prepped: prepLogs.qtyPrepped,
    })
    .from(prepLogs)
    .innerJoin(menuItems, eq(menuItems.id, prepLogs.itemId))
    .where(and(eq(prepLogs.outletId, input.outlet_id), eq(prepLogs.date, input.date)))
    .orderBy(asc(menuItems.name));
  return { outlet_id: input.outlet_id, date: input.date, rows };
}

/**
 * Logs one waste entry per line. Every line is checked first and all rows go in one INSERT, so
 * either every line is saved or none is (ADR 0014).
 */
export async function logWaste(db: Db, input: LogWasteInput): Promise<{ entries: WasteEntry[] }> {
  await requireOutlet(db, input.outlet_id);
  if (input.confirmed_by) await requireUser(db, input.outlet_id, input.confirmed_by);
  if (input.run_id) await requireRun(db, input.run_id);
  const loggedAt = input.logged_at ? checkLoggedAt(input.logged_at) : new Date();
  const values = [];
  for (const line of input.lines) {
    const item = await requireItem(db, input.outlet_id, line.item_id);
    const weightKg =
      line.portion_count !== undefined
        ? portionsToKg(line.portion_count, item)
        : round(line.weight_kg!, 3);
    values.push({
      outletId: input.outlet_id,
      itemId: line.item_id,
      loggedAt,
      weightKg: String(weightKg),
      portionCount: line.portion_count ?? null,
      cause: input.cause,
      source: input.source,
      photoPath: input.photo_path ?? null,
      confidence: input.confidence ?? null,
      confirmedBy: input.confirmed_by ?? null,
      runId: input.run_id ?? null,
    });
  }
  const rows = await db.insert(wasteEntries).values(values).returning({ id: wasteEntries.id });
  return {
    entries: await Promise.all(rows.map((row) => getEntry(db, input.outlet_id, row.id))),
  };
}

/** The waste entries of one outlet on its local days, optionally for one item or cause. */
async function wasteWhere(db: Db, filters: WasteFilters) {
  const outlet = await requireOutlet(db, filters.outlet_id);
  const tz = outlet.timezone;
  if (filters.item_id) await requireItem(db, filters.outlet_id, filters.item_id);

  // Outlet-local days: [from 00:00, to + 1 day 00:00) in the outlet's timezone.
  const where: SQL[] = [
    eq(wasteEntries.outletId, filters.outlet_id),
    sql`${wasteEntries.loggedAt} >= (${filters.from}::date)::timestamp at time zone ${tz}`,
    sql`${wasteEntries.loggedAt} < ((${filters.to}::date) + 1)::timestamp at time zone ${tz}`,
  ];
  if (filters.item_id) where.push(eq(wasteEntries.itemId, filters.item_id));
  if (filters.cause) where.push(eq(wasteEntries.cause, filters.cause));
  return { tz, where };
}

/**
 * Single waste entries with their ids, newest first, so a correction can name the entry to
 * update_entry. Bounded: at most MAX_LISTED_ENTRIES, with `truncated` when more matched.
 */
export async function listEntries(db: Db, input: ListEntriesInput): Promise<ListEntriesOutput> {
  const { tz, where } = await wasteWhere(db, input);
  const rows = await db
    .select({
      id: wasteEntries.id,
      itemId: wasteEntries.itemId,
      itemName: menuItems.name,
      loggedAt: wasteEntries.loggedAt,
      localDate: sql<string>`to_char(${wasteEntries.loggedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
      weightKg: wasteEntries.weightKg,
      portionCount: wasteEntries.portionCount,
      cause: wasteEntries.cause,
      source: wasteEntries.source,
    })
    .from(wasteEntries)
    .innerJoin(menuItems, eq(menuItems.id, wasteEntries.itemId))
    .where(and(...where))
    .orderBy(desc(wasteEntries.loggedAt), asc(wasteEntries.id))
    .limit(MAX_LISTED_ENTRIES + 1);
  return {
    outlet_id: input.outlet_id,
    from: input.from,
    to: input.to,
    timezone: tz,
    entries: rows.slice(0, MAX_LISTED_ENTRIES).map((r) => ({
      id: r.id,
      item_id: r.itemId,
      item_name: r.itemName,
      logged_at: r.loggedAt.toISOString(),
      local_date: r.localDate,
      weight_kg: Number(r.weightKg),
      portion_count: r.portionCount,
      cause: r.cause,
      source: r.source,
    })),
    truncated: rows.length > MAX_LISTED_ENTRIES,
  };
}

export async function queryWaste(db: Db, input: QueryWasteInput): Promise<QueryWasteOutput> {
  const { filters, group_by } = input;
  const { tz, where } = await wasteWhere(db, filters);

  // nullif: defence in depth for a database without migration 0002. An item with a 0 portion
  // weight still counts toward waste_kg, but is left out of the estimated portions and cost
  // instead of failing the whole query with division by zero.
  const portions = sql`${wasteEntries.weightKg} / nullif(${menuItems.portionWeightKg}, 0)`;
  const totals = {
    waste_kg: sql<string>`round(sum(${wasteEntries.weightKg}), 3)`,
    entries: sql<number>`count(*)::int`,
    portions: sql<string>`round(sum(${portions}), 1)`,
    cost_idr: sql<string>`round(sum(${portions} * ${menuItems.costPerPortion}), 0)`,
  };
  const localDate = sql<string>`to_char(${wasteEntries.loggedAt} at time zone ${tz}, 'YYYY-MM-DD')`;
  const base = (keys: Record<string, SQL | typeof menuItems.name | typeof wasteEntries.cause>) =>
    db
      .select({ ...keys, ...totals })
      .from(wasteEntries)
      .innerJoin(menuItems, eq(menuItems.id, wasteEntries.itemId))
      .where(and(...where));

  let rows: Record<string, unknown>[];
  if (group_by === "item")
    rows = await base({ item_id: sql<string>`${wasteEntries.itemId}`, item_name: menuItems.name })
      .groupBy(wasteEntries.itemId, menuItems.name)
      .orderBy(sql`sum(${wasteEntries.weightKg}) desc`, asc(menuItems.name));
  else if (group_by === "cause")
    rows = await base({ cause: wasteEntries.cause })
      .groupBy(wasteEntries.cause)
      .orderBy(sql`sum(${wasteEntries.weightKg}) desc`, asc(wasteEntries.cause));
  else if (group_by === "day")
    // Group and order by position: repeating the expression would bind the timezone as a
    // new parameter, and Postgres would not see it as the same expression.
    rows = await base({ date: localDate })
      .groupBy(sql`1`)
      .orderBy(sql`1`);
  else {
    rows = await base({});
    // An aggregate with no matching rows still returns one row of nulls.
    if (rows[0]?.entries === 0) rows = [];
  }

  return {
    outlet_id: filters.outlet_id,
    from: filters.from,
    to: filters.to,
    timezone: tz,
    group_by,
    groups: rows.map(({ waste_kg, entries, portions, cost_idr, ...keys }) => ({
      ...(keys as { item_id?: string; item_name?: string; cause?: string; date?: string }),
      waste_kg: Number(waste_kg),
      entries: Number(entries),
      portions: Number(portions),
      cost_idr: Number(cost_idr),
    })),
  };
}

export async function updateEntry(
  db: Db,
  input: UpdateEntryInput,
): Promise<{ before: WasteEntry; after: WasteEntry }> {
  const { outlet_id, id, patch } = input;
  await requireOutlet(db, outlet_id);
  const before = await getEntry(db, outlet_id, id);
  const itemId = patch.item_id ?? before.item_id;
  const item = await requireItem(db, outlet_id, itemId);

  const set: Partial<typeof wasteEntries.$inferInsert> = { itemId };
  if (patch.cause) set.cause = patch.cause;
  if (patch.logged_at) set.loggedAt = checkLoggedAt(patch.logged_at);
  if (patch.weight_kg !== undefined) {
    // A typed weight replaces the portion count, which would no longer match it.
    set.weightKg = String(round(patch.weight_kg, 3));
    set.portionCount = null;
  } else {
    const portions = patch.portion_count ?? before.portion_count;
    if (portions !== null && (patch.portion_count !== undefined || patch.item_id !== undefined)) {
      set.portionCount = portions;
      set.weightKg = String(portionsToKg(portions, item));
    }
  }
  await db
    .update(wasteEntries)
    .set(set)
    .where(and(eq(wasteEntries.id, id), eq(wasteEntries.outletId, outlet_id)));
  return { before, after: await getEntry(db, outlet_id, id) };
}
