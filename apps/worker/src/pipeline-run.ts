import { parseArgs } from "node:util";
import { createDb } from "@sisaku/db";
import { createPipelineRuns } from "./runs";
import { assertPostgres, assertRedis, pipelineRedis } from "./settings";

// pnpm pipeline:run --outlet <id or name> --date YYYY-MM-DD
// Queues one pipeline run by hand. The worker executes it.

const USAGE = "Usage: pnpm pipeline:run --outlet <id or name> --date YYYY-MM-DD";

function readArgs() {
  const { values } = parseArgs({
    options: { outlet: { type: "string" }, date: { type: "string" } },
  });
  const { outlet, date } = values;
  if (!outlet) throw new Error(`--outlet is required\n${USAGE}`);
  if (!date) throw new Error(`--date is required\n${USAGE}`);
  return { outlet, date };
}

async function main() {
  const request = readArgs();
  const redis = pipelineRedis();
  // Before the run is written, so a run is not left behind without jobs.
  await assertRedis(redis);
  const { db, pool } = createDb();
  const runs = createPipelineRuns({ db, redis });
  try {
    await assertPostgres(db);
    const { runId } = await runs.startManual(request);
    console.log(`Queued pipeline run ${runId}`);
  } finally {
    await Promise.allSettled([runs.close(), pool.end()]);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
