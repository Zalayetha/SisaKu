import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb, emissionFactors, menuItems, outlets, users, wasteEntries } from "@sisaku/db";

// Test-only helper. Needs TEST_DATABASE_URL (database name ending in _test): it runs the db
// package's `reset` and `up`, which wipes that database, then seeds a small known dataset.
export const testDbUrl = process.env.TEST_DATABASE_URL;

export const ids = {
  outletA: "00000000-0000-4000-8000-00000000000a", // Jakarta Selatan
  outletB: "00000000-0000-4000-8000-00000000000b", // Bandung
  outletC: "00000000-0000-4000-8000-00000000000c", // no location
  rendang: "00000000-0000-4000-8000-000000000101", // outlet A, beef
  nasi: "00000000-0000-4000-8000-000000000102", // outlet A, rice
  kerupuk: "00000000-0000-4000-8000-000000000103", // outlet A, "snack": no emission factor
  soto: "00000000-0000-4000-8000-000000000201", // outlet B, chicken
  managerA: "00000000-0000-4000-8000-000000000301",
  ownerA: "00000000-0000-4000-8000-000000000302",
  staffA: "00000000-0000-4000-8000-000000000303",
  managerB: "00000000-0000-4000-8000-000000000304",
} as const;

export const unknownId = "00000000-0000-4000-8000-0000000000ff";

/**
 * Simple factors so CO2e can be checked by hand (kg CO2e per kg): beef 10 + 1, rice 2 + 1,
 * chicken 5 + 1. Independent of the real values in packages/db/seed/emission_factors.csv.
 */
export const simpleFactors = [
  { foodCategory: "beef", productionKgCo2ePerKg: 10, landfillKgCo2ePerKg: 1, source: "test beef" },
  { foodCategory: "rice", productionKgCo2ePerKg: 2, landfillKgCo2ePerKg: 1, source: "test rice" },
  {
    foodCategory: "chicken",
    productionKgCo2ePerKg: 5,
    landfillKgCo2ePerKg: 1,
    source: "test chicken",
  },
];

export async function setupTestDb() {
  if (!testDbUrl) throw new Error("TEST_DATABASE_URL is not set");
  const cwd = fileURLToPath(new URL("../../db", import.meta.url));
  for (const d of ["reset", "up"])
    execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: testDbUrl },
    });

  const { db, pool } = createDb(testDbUrl);
  await db.insert(outlets).values([
    { id: ids.outletA, name: "Warung Test", location: "Jakarta Selatan", timezone: "Asia/Jakarta" },
    { id: ids.outletB, name: "Other Outlet", location: "Bandung", timezone: "Asia/Jakarta" },
    { id: ids.outletC, name: "No Location", timezone: "Asia/Jakarta" },
  ]);
  await db.insert(users).values([
    { id: ids.managerA, outletId: ids.outletA, name: "Manager A", role: "manager" },
    { id: ids.ownerA, outletId: ids.outletA, name: "Owner A", role: "owner" },
    { id: ids.staffA, outletId: ids.outletA, name: "Staff A", role: "staff" },
    { id: ids.managerB, outletId: ids.outletB, name: "Manager B", role: "manager" },
  ]);
  const item = (id: string, outletId: string, name: string, foodCategory: string) => ({
    id,
    outletId,
    name,
    category: "main",
    costPerPortion: "10000",
    portionWeightKg: "0.200",
    foodCategory,
  });
  await db
    .insert(menuItems)
    .values([
      item(ids.rendang, ids.outletA, "Rendang Sapi", "beef"),
      item(ids.nasi, ids.outletA, "Nasi Putih", "rice"),
      item(ids.kerupuk, ids.outletA, "Kerupuk", "snack"),
      item(ids.soto, ids.outletB, "Soto Ayam", "chicken"),
    ]);
  await db.insert(emissionFactors).values(simpleFactors);
  // Asia/Jakarta is UTC+7.
  const waste = (outletId: string, itemId: string, at: string, kg: string, cause: string) => ({
    outletId,
    itemId,
    loggedAt: new Date(at),
    weightKg: kg,
    cause,
    source: "text" as const,
  });
  await db.insert(wasteEntries).values([
    waste(ids.outletA, ids.rendang, "2026-03-01T14:00:00Z", "0.360", "over_prep"), // 03-01 21:00 local
    waste(ids.outletA, ids.nasi, "2026-03-01T18:00:00Z", "1.000", "spoilage"), // 03-02 01:00 local
    waste(ids.outletA, ids.kerupuk, "2026-03-01T05:00:00Z", "0.500", "expired"), // 03-01 12:00 local
    waste(ids.outletB, ids.soto, "2026-03-01T05:00:00Z", "0.900", "spoilage"),
  ]);
  return { db, pool };
}
