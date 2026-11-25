import { connectMcpServers, createLens } from "@sisaku/agents";
import { createDb } from "@sisaku/db";
import { assertPostgres, assertRedis, pipelineRedis } from "./settings";
import { createPipelineWorker } from "./worker";

// Fails fast (ADR 0017): every setting, and every connection but Lens, is checked before a job is
// taken. A Lens outage must never stop a run.
const redis = pipelineRedis();
// Its own service name, apart from the Copilot's.
const lens = createLens("sisaku-pipeline");
const { db, pool } = createDb();
await assertPostgres(db);
await assertRedis(redis);
const mcp = await connectMcpServers();

const worker = createPipelineWorker({
  db,
  servers: mcp.servers,
  redis,
  // "safe": no prompt, reply or tool bodies in Lens (ADR 0012).
  lens: {
    pipeline: lens.pipelineObserver({ captureMode: "safe" }),
    agent: lens.observer({ captureMode: "safe" }),
  },
});
console.error("Nightly pipeline worker is waiting for runs.");

const CLOSE_WAIT_MS = 5_000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  // A step left behind may still hold a connection; its worker must exit all the same.
  setTimeout(() => process.exit(0), CLOSE_WAIT_MS);
  await Promise.allSettled([mcp.close(), lens.close(), pool.end()]);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
