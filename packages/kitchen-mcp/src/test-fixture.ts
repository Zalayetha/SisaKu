import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb, menuItems, outlets, prepLogs, sales, users, wasteEntries } from "@sisaku/db";

// Test-only helper. Needs TEST_DATABASE_URL (database name ending in _test): it runs the db
// package's `reset` and `up`, which wipes that database, then seeds a small known dataset.
export const testDbUrl = process.env.TEST_DATABASE_URL;

export const ids = {
  outletA: "00000000-0000-4000-8000-00000000000a",
  outletB: "00000000-0000-4000-8000-00000000000b",
  nasi: "00000000-0000-4000-8000-000000000101", // outlet A, 0.200 kg, Rp 2,500
  rendang: "00000000-0000-4000-8000-000000000102", // outlet A, 0.120 kg, Rp 13,000
  soto: "00000000-0000-4000-8000-000000000201", // outlet B
  staffA: "00000000-0000-4000-8000-000000000301",
  staffB: "00000000-0000-4000-8000-000000000302",
  // Waste in outlet A. Asia/Jakarta is UTC+7.
  wasteRendangDay1: "00000000-0000-4000-8000-000000000401", // 2026-03-01 21:00 local, 3 portions
  wasteNasiDay2: "00000000-0000-4000-8000-000000000402", // 2026-03-02 01:00 local (still 03-01 in UTC)
  wasteRendangDay2: "00000000-0000-4000-8000-000000000403", // 2026-03-02 12:00 local, typed 0.24 kg
  wasteSotoB: "00000000-0000-4000-8000-000000000404",
} as const;

export const unknownId = "00000000-0000-4000-8000-0000000000ff";

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
    { id: ids.outletA, name: "Warung Test", timezone: "Asia/Jakarta" },
    { id: ids.outletB, name: "Other Outlet", timezone: "Asia/Jakarta" },
  ]);
  await db.insert(users).values([
    { id: ids.staffA, outletId: ids.outletA, name: "Staff A" },
    { id: ids.staffB, outletId: ids.outletB, name: "Staff B" },
  ]);
  const item = (id: string, outletId: string, name: string, cost: string, kg: string) => ({
    id,
    outletId,
    name,
    category: "main",
    costPerPortion: cost,
    portionWeightKg: kg,
    foodCategory: "rice",
  });
  await db
    .insert(menuItems)
    .values([
      item(ids.nasi, ids.outletA, "Nasi Putih", "2500", "0.200"),
      item(ids.rendang, ids.outletA, "Rendang Sapi", "13000", "0.120"),
      item(ids.soto, ids.outletB, "Soto Ayam", "9000", "0.300"),
    ]);
  const day = (n: number) => `2026-03-0${n}`;
  await db.insert(sales).values(
    [1, 2, 3].flatMap((n) => [
      { outletId: ids.outletA, itemId: ids.nasi, date: day(n), qtySold: 100 + n },
      { outletId: ids.outletA, itemId: ids.rendang, date: day(n), qtySold: 40 + n },
    ]),
  );
  await db
    .insert(sales)
    .values({ outletId: ids.outletB, itemId: ids.soto, date: day(1), qtySold: 7 });
  await db.insert(prepLogs).values([
    { outletId: ids.outletA, itemId: ids.nasi, date: day(1), qtyPrepped: 120 },
    { outletId: ids.outletA, itemId: ids.rendang, date: day(1), qtyPrepped: 50 },
  ]);
  const waste = (
    id: string,
    outletId: string,
    itemId: string,
    loggedAt: string,
    weightKg: string,
    portionCount: number | null,
    cause: string,
  ) => ({
    id,
    outletId,
    itemId,
    loggedAt: new Date(loggedAt),
    weightKg,
    portionCount,
    cause,
    source: "text" as const,
  });
  await db
    .insert(wasteEntries)
    .values([
      waste(
        ids.wasteRendangDay1,
        ids.outletA,
        ids.rendang,
        "2026-03-01T14:00:00Z",
        "0.360",
        3,
        "over_prep",
      ),
      waste(
        ids.wasteNasiDay2,
        ids.outletA,
        ids.nasi,
        "2026-03-01T18:00:00Z",
        "1.000",
        null,
        "spoilage",
      ),
      waste(
        ids.wasteRendangDay2,
        ids.outletA,
        ids.rendang,
        "2026-03-02T05:00:00Z",
        "0.240",
        null,
        "plate_waste",
      ),
      waste(ids.wasteSotoB, ids.outletB, ids.soto, "2026-03-01T05:00:00Z", "0.900", 3, "spoilage"),
    ]);
  return { db, pool };
}
