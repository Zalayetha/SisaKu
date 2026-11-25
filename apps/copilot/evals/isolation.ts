import { emissionFactors, menuItems, pickupRequests, wasteEntries } from "@sisaku/db";
import { eq } from "drizzle-orm";
import type { Db } from "../src/users";
import type { CopilotInput } from "./cases";

/** Every waste entry and pickup request, at every outlet, by id. */
export type Snapshot = ReadonlyMap<string, string>;

export async function takeSnapshot(db: Db): Promise<Snapshot> {
  const rows = [
    ...(await db.select().from(wasteEntries)).map((r) => [`waste entry ${r.id}`, r] as const),
    ...(await db.select().from(pickupRequests)).map((r) => [`pickup request ${r.id}`, r] as const),
  ];
  return new Map(rows.map(([id, row]) => [id, JSON.stringify(row)]));
}

/** Which rows were added, removed or edited between two snapshots. */
export function snapshotChanges(before: Snapshot, after: Snapshot): string[] {
  const added = [...after.keys()].filter((id) => !before.has(id)).map((id) => `${id} added`);
  const other = [...before].flatMap(([id, row]) => {
    if (!after.has(id)) return [`${id} removed`];
    return after.get(id) === row ? [] : [`${id} edited`];
  });
  return [...added, ...other];
}

type Plant = NonNullable<CopilotInput["plant"]>;

/** Puts a case's hostile text in the test database; the returned function puts it back. */
export async function plantText(db: Db, plant: Plant): Promise<() => Promise<void>> {
  const undo: (() => Promise<unknown>)[] = [];
  const { menuItemName, emissionSource } = plant;
  if (menuItemName) {
    const where = eq(menuItems.id, menuItemName.itemId);
    const [row] = await db.select({ name: menuItems.name }).from(menuItems).where(where);
    if (!row) throw new Error(`No menu item ${menuItemName.itemId} to plant text in`);
    await db.update(menuItems).set({ name: menuItemName.text }).where(where);
    undo.push(() => db.update(menuItems).set({ name: row.name }).where(where));
  }
  if (emissionSource) {
    const where = eq(emissionFactors.foodCategory, emissionSource.foodCategory);
    const [row] = await db
      .select({ source: emissionFactors.source })
      .from(emissionFactors)
      .where(where);
    if (!row) throw new Error(`No ${emissionSource.foodCategory} factor to plant text in`);
    await db.update(emissionFactors).set({ source: emissionSource.text }).where(where);
    undo.push(() => db.update(emissionFactors).set({ source: row.source }).where(where));
  }
  return async () => {
    for (const restore of undo.splice(0)) await restore();
  };
}
