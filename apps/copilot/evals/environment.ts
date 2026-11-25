import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@anvia/core/mcp";
import type { CopilotRole } from "@sisaku/agents";
import { createDb, importCsv, outlets, users, wasteEntries } from "@sisaku/db";
import { generateMockData, loadDataset } from "@sisaku/mock-data";
import { eq } from "drizzle-orm";
import { connectInMemoryServers } from "../src/testing/mcp-servers";
import type { Db } from "../src/users";
import { EVAL_OUTLET, savedEntries } from "./cases";
import { noonIn } from "./clock";

export const EVAL_OWNER_TELEGRAM_ID = "eval-owner";

/** Everything a case runs against: a throwaway database seeded with the default mock data. */
export type EvalEnvironment = {
  db: Db;
  servers: readonly McpServer[];
  outlet: { id: string; name: string; timezone: string };
  telegramIdByRole: Readonly<Record<CopilotRole, string>>;
  close(): Promise<void>;
};

/**
 * Wipes and migrates the database at `url`, loads `generateMockData()`, the emission factors and
 * the correction cases' saved entries, adds an owner at the eval outlet, and connects kitchen-mcp and impact-mcp to it. Refuses any database whose name
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
  // The mock data leaves emission factors alone; without them every CO₂e answer is 0.
  const factors = new URL("../../../packages/db/seed/emission_factors.csv", import.meta.url);
  const imported = await importCsv(db, { emission_factors: readFileSync(factors, "utf8") });
  if (!imported.ok) throw new Error("The emission factors could not be loaded");
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
    .select({ id: users.id, role: users.role, telegramUserId: users.telegramUserId })
    .from(users)
    .where(eq(users.outletId, outlet.id));
  const telegramId = (role: CopilotRole) => {
    const id = people.find((p) => p.role === role)?.telegramUserId;
    if (!id) throw new Error(`${EVAL_OUTLET} has no ${role} with a Telegram id`);
    return id;
  };
  const staffId = people.find((p) => p.role === "staff")?.id;
  if (!staffId) throw new Error(`${EVAL_OUTLET} has no staff user`);
  await db.insert(wasteEntries).values(
    savedEntries.map(({ day, ...entry }) => ({
      ...entry,
      outletId: outlet.id,
      // An hour before the case's clock, so "tadi" is earlier the same day.
      loggedAt: new Date(noonIn(day, outlet.timezone).getTime() - 60 * 60 * 1000),
      source: "text" as const,
      confirmedBy: staffId,
    })),
  );

  const mcp = await connectInMemoryServers(db);
  return {
    db,
    servers: mcp.servers,
    outlet,
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
