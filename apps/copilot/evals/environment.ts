import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@anvia/core/mcp";
import { createDb, menuItems, outlets, users } from "@sisaku/db";
import { generateMockData, loadDataset } from "@sisaku/mock-data";
import { eq } from "drizzle-orm";
import { connectInMemoryServers } from "../src/testing/harness";
import type { Db } from "../src/users";

export const EVAL_OUTLET = "Warung Rina";
export const EVAL_OWNER_TELEGRAM_ID = "eval-owner";

type Role = "staff" | "manager" | "owner";

/** Everything a case runs against: a throwaway database seeded with the default mock data. */
export type EvalEnvironment = {
  db: Db;
  servers: readonly McpServer[];
  outlet: { id: string; name: string; timezone: string };
  /** The eval outlet's menu, name → id, for `{item:<name>}` placeholders. */
  menu: ReadonlyMap<string, string>;
  telegramIdByRole: Readonly<Record<Role, string>>;
  close(): Promise<void>;
};

/**
 * Wipes and migrates the database at `url`, loads `generateMockData()`, adds an owner at the
 * eval outlet, and connects kitchen-mcp and impact-mcp to it. Refuses any database whose name
 * does not end in `_test`, so a dev or production database can never be wiped by mistake.
 */
export async function prepareEvalEnvironment(url: string): Promise<EvalEnvironment> {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`The eval wipes its database; "${name}" does not end in _test`);
  }
  const cwd = fileURLToPath(new URL("../../../packages/db", import.meta.url));
  for (const step of ["reset", "up"]) {
    execSync(`pnpm exec tsx scripts/migrate.ts ${step}`, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: url },
    });
  }
  await loadDataset(generateMockData(), { url });

  const { db, pool } = createDb(url);
  const [outlet] = await db
    .select({ id: outlets.id, name: outlets.name, timezone: outlets.timezone })
    .from(outlets)
    .where(eq(outlets.name, EVAL_OUTLET));
  if (!outlet) throw new Error(`${EVAL_OUTLET} is not in the mock data`);
  // The mock data has a manager and a staff member per outlet, but no owner.
  await db.insert(users).values({
    outletId: outlet.id,
    name: "Eval Owner",
    telegramUserId: EVAL_OWNER_TELEGRAM_ID,
    role: "owner",
  });
  const people = await db
    .select({ role: users.role, telegramUserId: users.telegramUserId })
    .from(users)
    .where(eq(users.outletId, outlet.id));
  const telegramId = (role: Role) => {
    const id = people.find((p) => p.role === role)?.telegramUserId;
    if (!id) throw new Error(`${EVAL_OUTLET} has no ${role} with a Telegram id`);
    return id;
  };
  const items = await db
    .select({ id: menuItems.id, name: menuItems.name })
    .from(menuItems)
    .where(eq(menuItems.outletId, outlet.id));

  const mcp = await connectInMemoryServers(db);
  return {
    db,
    servers: mcp.servers,
    outlet,
    menu: new Map(items.map((i) => [i.name, i.id])),
    telegramIdByRole: {
      staff: telegramId("staff"),
      manager: telegramId("manager"),
      owner: telegramId("owner"),
    },
    async close() {
      await mcp.close();
      await pool.end();
    },
  };
}
