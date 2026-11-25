import { serve } from "@hono/node-server";
import { PIPELINE_QUEUE, queueOptions } from "@sisaku/worker/queue";
import { assertRedis, pipelineRedis } from "@sisaku/worker/settings";
import { Queue } from "bullmq";
import { createBoardApp } from "./board";
import { boardSettings } from "./settings";

// Fails fast: every setting and Redis are checked before anything is served.
const { user, password, host, port } = boardSettings();
const redis = pipelineRedis();
await assertRedis(redis);

const queue = new Queue(PIPELINE_QUEUE, queueOptions(redis));
// Redis may go away and come back while the board stays up.
queue.on("error", (error) => console.error("Pipeline queue error", error));
const app = createBoardApp({ queue, user, password });
const server = serve({ fetch: app.fetch, hostname: host, port }, () =>
  console.error(`Bull Board is on http://${host}:${port}`),
);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  // A browser's open connection must not hold it up.
  setTimeout(() => process.exit(0), 2_000).unref();
  server.close(() => void queue.close().finally(() => process.exit(0)));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
