import { Redis } from "ioredis";
import type { PipelineRedis } from "./queue";

/** The queue's Redis, from REDIS_URL. PIPELINE_REDIS_PREFIX keeps test processes apart. */
export function pipelineRedis(env: NodeJS.ProcessEnv = process.env): PipelineRedis {
  const url = env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  const prefix = env.PIPELINE_REDIS_PREFIX;
  return { url, ...(prefix ? { prefix } : {}) };
}

/** Fails at once when Redis cannot be reached; BullMQ itself would wait and retry forever. */
export async function assertRedis({ url }: PipelineRedis): Promise<void> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  let cause: unknown;
  client.on("error", (error) => (cause = error));
  try {
    await client.connect();
    await client.ping();
  } catch (error) {
    throw new Error("Redis at REDIS_URL cannot be reached", { cause: cause ?? error });
  } finally {
    client.disconnect();
  }
}
