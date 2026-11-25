import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

// Test-only helper. Needs TEST_REDIS_URL. Every test file works under a key prefix of its own and
// deletes only those keys.
export const testRedisUrl = process.env.TEST_REDIS_URL;

export function testRedis() {
  if (!testRedisUrl) throw new Error("TEST_REDIS_URL is not set");
  const prefix = `sisaku-test-${randomUUID()}`;
  const client = new Redis(testRedisUrl);
  const keys = () => client.keys(`${prefix}:*`);
  const clear = async () => {
    const found = await keys();
    if (found.length > 0) await client.del(...found);
  };
  return {
    redis: { url: testRedisUrl, prefix },
    clear,
    async close() {
      await clear();
      await client.quit();
    },
  };
}
