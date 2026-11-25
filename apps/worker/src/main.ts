import { connectMcpServers, createLens } from "@sisaku/agents";
import { createDb } from "@sisaku/db";
import { sql } from "drizzle-orm";
import { assertRedis, pipelineRedis } from "./settings";
import { createPipelineWorker } from "./worker";

// Fails fast (ADR 0017): every setting and connection is checked before a job is taken.
const redis = pipelineRedis();
// Its own service name, apart from the Copilot's.
const lens = createLens("sisaku-pipeline");
const { db, pool } = createDb();
await db.execute(sql`select 1`);
await assertRedis(redis);
const mcp = await connectMcpServers();

const worker = createPipelineWorker({ db, servers: mcp.servers, redis });
console.error("Nightly pipeline worker is waiting for runs.");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await Promise.allSettled([mcp.close(), lens.close(), pool.end()]);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
