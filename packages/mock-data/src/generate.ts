import type { InferInsertModel } from "drizzle-orm";
import type { menuItems, outlets, prepLogs, sales, users, wasteEntries } from "@sisaku/db/schema";
import { addDays, eventsOn, weekday } from "./calendar.js";
import { createRng, type Rng } from "./rng.js";

export const DEFAULT_SEED = 20261119;
export const DEFAULT_START = "2026-02-01"; // 60 days covering Ramadan 2026 and Eid al-Fitr
export const DEFAULT_DAYS = 60;
export const HELD_OUT_DAYS = 14;

export const WASTE_CAUSES = [
  "over_prep",
  "spoilage",
  "plate_waste",
  "prep_error",
  "expired",
] as const;

export type OutletRow = InferInsertModel<typeof outlets> & { id: string };
export type UserRow = InferInsertModel<typeof users> & { id: string };
export type MenuItemRow = InferInsertModel<typeof menuItems> & { id: string };
export type SaleRow = InferInsertModel<typeof sales>;
export type PrepLogRow = InferInsertModel<typeof prepLogs>;
export type WasteEntryRow = InferInsertModel<typeof wasteEntries> & { id: string };

/** Ground truth for evals. Never loaded into the database. */
export interface SpikeTruth {
  outletId: string;
  date: string;
  itemId: string | null; // null = whole outlet
  multiplier: number;
  reason: string;
}

export interface MockDataset {
  seed: number;
  startDate: string;
  endDate: string;
  heldOutFrom: string;
  outlets: OutletRow[];
  users: UserRow[];
  menuItems: MenuItemRow[];
  sales: SaleRow[];
  prepLogs: PrepLogRow[];
  wasteEntries: WasteEntryRow[];
  spikes: SpikeTruth[];
}

export interface GenerateOptions {
  seed?: number;
  startDate?: string;
  days?: number;
}

interface ItemTemplate {
  name: string;
  category: "main" | "side" | "drink" | "dessert";
  foodCategory: string; // joins emission_factors.food_category
  cost: number; // Rupiah per portion
  portionKg: number;
  base: number; // portions per normal day
}

const MENU: ItemTemplate[] = [
  {
    name: "Nasi Putih",
    category: "side",
    foodCategory: "rice",
    cost: 2500,
    portionKg: 0.2,
    base: 90,
  },
  {
    name: "Rendang Sapi",
    category: "main",
    foodCategory: "beef",
    cost: 14000,
    portionKg: 0.12,
    base: 35,
  },
  {
    name: "Ayam Goreng",
    category: "main",
    foodCategory: "chicken",
    cost: 9000,
    portionKg: 0.15,
    base: 55,
  },
  {
    name: "Ikan Bakar",
    category: "main",
    foodCategory: "fish",
    cost: 12000,
    portionKg: 0.18,
    base: 25,
  },
  {
    name: "Telur Balado",
    category: "main",
    foodCategory: "eggs",
    cost: 4000,
    portionKg: 0.1,
    base: 30,
  },
  {
    name: "Tempe Orek",
    category: "side",
    foodCategory: "soy",
    cost: 1800,
    portionKg: 0.06,
    base: 40,
  },
  {
    name: "Sayur Lodeh",
    category: "side",
    foodCategory: "vegetables",
    cost: 2500,
    portionKg: 0.15,
    base: 35,
  },
  {
    name: "Gado-gado",
    category: "main",
    foodCategory: "vegetables",
    cost: 7000,
    portionKg: 0.25,
    base: 28,
  },
  {
    name: "Es Campur",
    category: "dessert",
    foodCategory: "fruit",
    cost: 5000,
    portionKg: 0.3,
    base: 20,
  },
  {
    name: "Kolak Pisang",
    category: "dessert",
    foodCategory: "fruit",
    cost: 3500,
    portionKg: 0.25,
    base: 12,
  },
];

interface OutletTemplate {
  name: string;
  location: string;
  scale: number;
  weekendLift: number;
  menuSkip: string[];
}

const OUTLETS: OutletTemplate[] = [
  {
    name: "Warung Rina",
    location: "Jakarta Selatan",
    scale: 1,
    weekendLift: 1.25,
    menuSkip: ["Kolak Pisang"],
  },
  {
    name: "Rumah Makan Sari Minang",
    location: "Bandung",
    scale: 0.8,
    weekendLift: 0.9,
    menuSkip: ["Gado-gado"],
  },
];

const WEEKDAY_FACTOR = [1.0, 0.95, 0.95, 1.0, 1.05, 1.15, 1.2]; // Sun..Sat, scaled by outlet weekendLift

function weekdayFactor(date: string, weekendLift: number): number {
  const wd = weekday(date);
  const f = WEEKDAY_FACTOR[wd]!;
  return wd === 0 || wd === 6 ? f * (weekendLift / 1.1) : f;
}

function calendarFactor(date: string, category: ItemTemplate["category"]): number {
  let f = 1;
  for (const e of eventsOn(date)) {
    f *= e.demandFactor;
    // Ramadan: takjil-style sweet items sell more even as lunch dips.
    if (e.kind === "ramadan" && (category === "dessert" || category === "drink")) f *= 1.9;
  }
  return f;
}

function addSpikes(
  rng: Rng,
  outletId: string,
  dates: string[],
  items: MenuItemRow[],
  heldOutFrom: string,
): SpikeTruth[] {
  const reasons = [
    "catering order",
    "office event",
    "viral social post",
    "school outing",
    "nearby road closure",
  ];
  const eligible = (d: string) => eventsOn(d).length === 0; // spikes are NOT on any calendar day
  const make = (date: string): SpikeTruth => {
    const wholeOutlet = rng.chance(0.4);
    return {
      outletId,
      date,
      itemId: wholeOutlet ? null : rng.pick(items).id,
      multiplier: Math.round((1.6 + rng.next() * 1.0) * 100) / 100,
      reason: rng.pick(reasons),
    };
  };
  const used = new Set<string>();
  const out: SpikeTruth[] = [];
  const place = (pool: string[], count: number) => {
    const free = pool.filter((d) => eligible(d) && !used.has(d));
    for (let i = 0; i < count && free.length > 0; i++) {
      const d = free.splice(rng.int(0, free.length - 1), 1)[0]!;
      used.add(d);
      out.push(make(d));
    }
  };
  // Guarantee spikes inside the held-out window so the forecast eval sees them.
  place(
    dates.filter((d) => d >= heldOutFrom),
    2,
  );
  place(
    dates.filter((d) => d < heldOutFrom),
    3,
  );
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function generateMockData(opts: GenerateOptions = {}): MockDataset {
  const seed = opts.seed ?? DEFAULT_SEED;
  const startDate = opts.startDate ?? DEFAULT_START;
  const days = opts.days ?? DEFAULT_DAYS;
  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  const endDate = dates[dates.length - 1]!;
  const heldOutFrom = dates[Math.max(0, days - HELD_OUT_DAYS)]!;

  const dataset: MockDataset = {
    seed,
    startDate,
    endDate,
    heldOutFrom,
    outlets: [],
    users: [],
    menuItems: [],
    sales: [],
    prepLogs: [],
    wasteEntries: [],
    spikes: [],
  };

  OUTLETS.forEach((o, oi) => {
    // One stream per outlet: changing one outlet's code never shifts the other's data.
    const rng = createRng(`${seed}:outlet:${oi}`);
    const outletId = rng.uuid();
    dataset.outlets.push({
      id: outletId,
      name: o.name,
      location: o.location,
      timezone: "Asia/Jakarta",
    });

    const manager: UserRow = {
      id: rng.uuid(),
      outletId,
      name: `${o.name} Manager`,
      telegramUserId: `mock-${oi}-manager`,
      role: "manager",
    };
    const staff: UserRow = {
      id: rng.uuid(),
      outletId,
      name: `${o.name} Staff`,
      telegramUserId: `mock-${oi}-staff`,
      role: "staff",
    };
    dataset.users.push(manager, staff);

    const templates = MENU.filter((t) => !o.menuSkip.includes(t.name));
    const items: MenuItemRow[] = templates.map((t) => ({
      id: rng.uuid(),
      outletId,
      name: t.name,
      category: t.category,
      foodCategory: t.foodCategory,
      costPerPortion: (t.cost * (0.95 + rng.next() * 0.1)).toFixed(2),
      portionWeightKg: t.portionKg.toFixed(3),
    }));
    dataset.menuItems.push(...items);

    const spikes = addSpikes(rng, outletId, dates, items, heldOutFrom);
    dataset.spikes.push(...spikes);

    const history = new Map<string, Map<string, number>>(); // itemId -> date -> sold

    for (const date of dates) {
      const todaysSpikes = spikes.filter((s) => s.date === date);
      for (let k = 0; k < items.length; k++) {
        const item = items[k]!;
        const t = templates[k]!;
        const sold = history.get(item.id) ?? new Map<string, number>();
        history.set(item.id, sold);

        // Demand: base x outlet x weekday x calendar x multiplicative noise, plus any surprise spike.
        const noise = Math.max(0.5, rng.normal(1, 0.1));
        let demand =
          t.base *
          o.scale *
          weekdayFactor(date, o.weekendLift) *
          calendarFactor(date, t.category) *
          noise;
        const spike = todaysSpikes.find((s) => s.itemId === null || s.itemId === item.id);
        if (spike) demand *= spike.multiplier;
        const qtyDemand = Math.max(0, Math.round(demand));

        // Manager preps from the last two same weekdays plus a buffer; blind to holidays beyond that.
        const prior = [addDays(date, -7), addDays(date, -14)]
          .map((d) => sold.get(d))
          .filter((v): v is number => v !== undefined);
        const reference =
          prior.length > 0 ? prior.reduce((a, b) => a + b, 0) / prior.length : t.base * o.scale;
        let prep = Math.max(1, Math.round(reference * (1.12 + rng.normal(0, 0.08))));

        // Sold-out vs top-up: on spike days the kitchen always scrambles to cook more.
        let qtySold = qtyDemand;
        if (qtyDemand > prep) {
          if (spike || rng.chance(0.7)) prep = qtyDemand;
          else qtySold = prep;
        }
        sold.set(date, qtySold);

        dataset.sales.push({ outletId, itemId: item.id, date, qtySold });
        dataset.prepLogs.push({ outletId, itemId: item.id, date, qtyPrepped: prep });

        // Waste: most of the leftover is binned; staff log it at close (about 21:30 WIB).
        const leftover = prep - qtySold;
        const portionKg = Number(item.portionWeightKg);
        const loggedAt = new Date(`${date}T14:30:00Z`);
        const addEntry = (portions: number, cause: (typeof WASTE_CAUSES)[number]) => {
          if (portions <= 0) return;
          const photo = rng.chance(0.65);
          const id = rng.uuid();
          dataset.wasteEntries.push({
            id,
            outletId,
            itemId: item.id,
            loggedAt,
            weightKg: (portions * portionKg).toFixed(3), // portion count x stored portion weight
            portionCount: portions,
            cause,
            source: photo ? "photo" : "text",
            photoUrl: photo ? `mock://photos/${id}.jpg` : null,
            confidence: photo ? Math.round((0.6 + rng.next() * 0.35) * 100) / 100 : null,
            confirmedBy: staff.id,
          });
        };
        if (leftover > 0) {
          const binned = Math.max(1, Math.round(leftover * (0.6 + rng.next() * 0.4)));
          const perishable = t.foodCategory === "fish" || t.foodCategory === "vegetables";
          addEntry(
            binned,
            perishable && rng.chance(0.3) ? "spoilage" : rng.chance(0.1) ? "expired" : "over_prep",
          );
        }
        if (rng.chance(0.07))
          addEntry(rng.int(1, 3), rng.chance(0.5) ? "plate_waste" : "prep_error");
      }
    }
  });

  return dataset;
}
