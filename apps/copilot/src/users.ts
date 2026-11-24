import { outlets, users, type createDb } from "@sisaku/db";
import { eq } from "drizzle-orm";
import type { CopilotRole } from "@sisaku/agents";

export type Db = ReturnType<typeof createDb>["db"];

/**
 * The registered user behind a Telegram sender. Their own name is left out: it never goes to the
 * model or Lens. The outlet's name goes to the model only.
 */
export type CopilotUser = {
  id: string;
  outletId: string;
  outletName: string;
  role: CopilotRole;
  timezone: string;
};

export type UserLookup = (telegramUserId: string) => Promise<CopilotUser | undefined>;

/**
 * Fixed code, not an MCP tool (ADR 0012), so the model has no way to look up users.
 */
export function createUserLookup(db: Db): UserLookup {
  return async (telegramUserId) => {
    const [row] = await db
      .select({
        id: users.id,
        outletId: users.outletId,
        outletName: outlets.name,
        role: users.role,
        timezone: outlets.timezone,
      })
      .from(users)
      .innerJoin(outlets, eq(outlets.id, users.outletId))
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);
    return row;
  };
}
