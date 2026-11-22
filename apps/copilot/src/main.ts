import { connectMcpServers, createLens, createModel } from "@sisaku/agents";
import { createDb } from "@sisaku/db";
import { sql } from "drizzle-orm";
import { ChatHistory } from "./history";
import { createTelegramService } from "./telegram";
import { createTurnHandler } from "./turn";
import { createUserLookup } from "./users";

// Fails fast (ADR 0012): every setting and connection is checked before the bot polls.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
const model = createModel();
const lens = createLens("sisaku-copilot");
const { db, pool } = createDb();
await db.execute(sql`select 1`);
const mcp = await connectMcpServers();

const service = createTelegramService({
  token,
  handleTurn: createTurnHandler({
    lookupUser: createUserLookup(db),
    servers: mcp.servers,
    model,
    // "safe": no prompt, reply or tool bodies in Lens (ADR 0012).
    observer: lens.observer({ captureMode: "safe" }),
    history: new ChatHistory(20),
  }),
});
await service.start();
console.error("Kitchen Copilot is polling Telegram.");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await service.stop();
  await Promise.allSettled([mcp.close(), lens.close(), pool.end()]);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
