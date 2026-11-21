import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  foreignKey,
  pgTable,
  unique,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["staff", "manager", "owner"]);
export const wasteSource = pgEnum("waste_source", ["photo", "text"]);

/**
 * Allowed values for `waste_entries.cause`. The column stays text; writers (kitchen-mcp,
 * mock-data) validate against this list so a new cause needs no migration.
 */
export const WASTE_CAUSES = [
  "over_prep",
  "spoilage",
  "plate_waste",
  "prep_error",
  "expired",
] as const;
export type WasteCause = (typeof WASTE_CAUSES)[number];
export const recommendationStatus = pgEnum("recommendation_status", [
  "pending",
  "approved",
  "rejected",
]);
export const pickupStatus = pgEnum("pickup_status", [
  "draft",
  "pending",
  "approved",
  "rejected",
  "submitted",
]);
export const agentRunStatus = pgEnum("agent_run_status", ["running", "succeeded", "failed"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const outlets = pgTable("outlets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  location: text("location"),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  outletId: uuid("outlet_id")
    .notNull()
    .references(() => outlets.id),
  name: text("name").notNull(),
  telegramUserId: text("telegram_user_id").unique(),
  role: userRole("role").notNull().default("staff"),
});

export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id),
    name: text("name").notNull(),
    category: text("category").notNull(),
    costPerPortion: numeric("cost_per_portion", { precision: 12, scale: 2 }).notNull(), // Rupiah
    portionWeightKg: numeric("portion_weight_kg", { precision: 8, scale: 3 }).notNull(),
    foodCategory: text("food_category").notNull(), // joins emission_factors.food_category
  },
  (t) => [
    index("menu_items_outlet_idx").on(t.outletId),
    unique("menu_items_id_outlet_id_unique").on(t.id, t.outletId),
  ],
);

export const sales = pgTable(
  "sales",
  {
    outletId: uuid("outlet_id").notNull(),
    itemId: uuid("item_id").notNull(),
    date: date("date").notNull(),
    qtySold: integer("qty_sold").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.itemId, t.outletId],
      foreignColumns: [menuItems.id, menuItems.outletId],
      name: "sales_item_outlet_fk",
    }),
    primaryKey({ columns: [t.outletId, t.itemId, t.date] }),
  ],
);

export const prepLogs = pgTable(
  "prep_logs",
  {
    outletId: uuid("outlet_id").notNull(),
    itemId: uuid("item_id").notNull(),
    date: date("date").notNull(),
    qtyPrepped: integer("qty_prepped").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.itemId, t.outletId],
      foreignColumns: [menuItems.id, menuItems.outletId],
      name: "prep_logs_item_outlet_fk",
    }),
    primaryKey({ columns: [t.outletId, t.itemId, t.date] }),
  ],
);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  agent: text("agent").notNull(),
  trigger: text("trigger").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  status: agentRunStatus("status").notNull().default("running"),
  traceId: text("trace_id"), // Anvia Lens
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
});

export const wasteEntries = pgTable(
  "waste_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id").notNull(),
    itemId: uuid("item_id").notNull(),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
    weightKg: numeric("weight_kg", { precision: 8, scale: 3 }).notNull(), // always kg
    portionCount: integer("portion_count"),
    cause: text("cause").notNull(),
    source: wasteSource("source").notNull(),
    photoUrl: text("photo_url"),
    confidence: doublePrecision("confidence"),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
  },
  (t) => [
    foreignKey({
      columns: [t.itemId, t.outletId],
      foreignColumns: [menuItems.id, menuItems.outletId],
      name: "waste_entries_item_outlet_fk",
    }),
    index("waste_entries_outlet_logged_idx").on(t.outletId, t.loggedAt),
  ],
);

export const forecasts = pgTable(
  "forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id),
    outletId: uuid("outlet_id").notNull(),
    itemId: uuid("item_id").notNull(),
    date: date("date").notNull(),
    baselineQty: doublePrecision("baseline_qty").notNull(),
    adjustedQty: doublePrecision("adjusted_qty"),
    reason: text("reason"), // required when adjustedQty differs from baseline
    model: text("model").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.itemId, t.outletId],
      foreignColumns: [menuItems.id, menuItems.outletId],
      name: "forecasts_item_outlet_fk",
    }),
    index("forecasts_outlet_date_idx").on(t.outletId, t.date),
  ],
);

// Baseline lives on forecasts only; join via forecast_id.
export const recommendations = pgTable("recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => agentRuns.id),
  forecastId: uuid("forecast_id")
    .notNull()
    .references(() => forecasts.id),
  prepQty: integer("prep_qty").notNull(),
  confidence: doublePrecision("confidence"),
  status: recommendationStatus("status").notNull().default("pending"),
  approvedBy: uuid("approved_by").references(() => users.id),
});

export const pickupRequests = pgTable("pickup_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  outletId: uuid("outlet_id")
    .notNull()
    .references(() => outlets.id),
  foodbankId: text("foodbank_id").notNull(), // mock food bank list lives in impact-mcp
  items: jsonb("items").notNull(),
  status: pickupStatus("status").notNull().default("draft"),
  createdAt: createdAt(),
  approvedBy: uuid("approved_by").references(() => users.id),
});

export const emissionFactors = pgTable("emission_factors", {
  foodCategory: text("food_category").primaryKey(),
  productionKgCo2ePerKg: doublePrecision("production_kg_co2e_per_kg").notNull(),
  landfillKgCo2ePerKg: doublePrecision("landfill_kg_co2e_per_kg").notNull(),
  source: text("source").notNull(),
});
