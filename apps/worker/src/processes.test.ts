import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentRuns, outlets } from "@sisaku/db";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { PIPELINE_QUEUE, queueOptions } from "./queue";
import { startLensServer } from "./testing/lens-server";
import { testRedis, testRedisUrl } from "./testing/redis";

// The worker and the pipeline:run command as real processes, without the repo's .env.

const cwd = fileURLToPath(new URL("..", import.meta.url));
const DEAD_MCP = "http://127.0.0.1:1/mcp";
const PRIVATE = { MCP_SSRF_PROTECTION: "disabled" };
const NO_MCP = /Version negotiation probe failed: fetch failed/;
const DEAD_REDIS = "redis://127.0.0.1:1";

/** A timezone in which it is now `hour` o'clock, whenever the test runs. */
function zoneWhereItIs(hour: number) {
  const ahead = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  // "Etc/GMT-7" is 7 hours ahead of UTC.
  return ahead === 0 ? "Etc/GMT" : `Etc/GMT${ahead > 0 ? "-" : "+"}${Math.abs(ahead)}`;
}

describe.skipIf(!testDbUrl || !testRedisUrl)("worker processes", { timeout: 60_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let redis: ReturnType<typeof testRedis>;
  let settings: Record<string, string>;
  // Read once: the hour may turn while the tests run.
  const DAYTIME = zoneWhereItIs(12);
  const LATE = zoneWhereItIs(23);

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    // In the day, so that a starting worker has no missed night to catch up.
    await db.update(outlets).set({ timezone: DAYTIME });
    redis = testRedis();
    settings = {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      DATABASE_URL: testDbUrl!,
      REDIS_URL: testRedisUrl!,
      PIPELINE_REDIS_PREFIX: redis.redis.prefix,
      ANVIA_LENS_BASE_URL: "http://127.0.0.1:1",
      ANVIA_LENS_PUBLIC_KEY: "pk",
      ANVIA_LENS_SECRET_KEY: "sk",
    };
  });
  afterAll(async () => {
    await redis?.close();
    await pool?.end();
  });

  function start(script: string, args: string[], env: Record<string, string>) {
    const child = spawn("node", ["--import", "tsx", script, ...args], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    return { child, exit, output: () => output };
  }

  async function run(script: string, args: string[], env: Record<string, string>) {
    const process = start(script, args, env);
    return { code: await process.exit, output: process.output() };
  }

  const without = (name: string) =>
    Object.fromEntries(Object.entries(settings).filter(([key]) => key !== name));

  const command = (args: string[], env = settings) => run("src/pipeline-run.ts", args, env);

  it("pipeline:run queues a run that the worker finishes, and the worker stops on SIGTERM", async () => {
    const { code, output } = await command(["--outlet", "Warung Test", "--date", "2026-03-01"]);
    expect(code).toBe(0);
    const runId = /[0-9a-f]{8}-[0-9a-f-]{27}/.exec(output)![0];

    const worker = start("src/main.ts", [], settings);
    await expect
      .poll(
        async () =>
          (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]?.status ??
          worker.output(),
        { timeout: 30_000 },
      )
      .toBe("succeeded");
    worker.child.kill("SIGTERM");
    expect(await worker.exit).toBe(0);
  });

  it("the worker schedules every outlet, and catches up a night that was just missed", async () => {
    await db.update(outlets).set({ timezone: LATE }).where(eq(outlets.id, ids.outletB));
    const queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis));
    const scheduledRuns = () =>
      db.select().from(agentRuns).where(eq(agentRuns.trigger, "schedule"));
    try {
      const worker = start("src/main.ts", [], settings);
      await expect
        .poll(async () => (await scheduledRuns())[0]?.status ?? worker.output(), {
          timeout: 30_000,
        })
        .toBe("succeeded");
      expect((await scheduledRuns()).map((run) => run.outletId)).toEqual([ids.outletB]);
      expect((await queue.getJobSchedulers()).map(({ tz }) => tz).sort()).toEqual(
        [LATE, DAYTIME].sort(),
      );
      worker.child.kill("SIGTERM");
      expect(await worker.exit).toBe(0);
    } finally {
      await db.update(outlets).set({ timezone: DAYTIME });
      await queue.close();
    }
  });

  it("the worker sends one trace per run to Lens, and flushes it on SIGTERM", async () => {
    const lens = await startLensServer();
    try {
      const { output } = await command(["--outlet", "Warung Test", "--date", "2026-03-02"]);
      const runId = /[0-9a-f]{8}-[0-9a-f-]{27}/.exec(output)![0];
      const worker = start("src/main.ts", [], { ...settings, ...lens.env });
      const readRun = async () =>
        (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
      await expect
        .poll(async () => (await readRun()).status, { timeout: 30_000 })
        .toBe("succeeded");
      // At once, so the spans are still waiting for the next batch.
      worker.child.kill("SIGTERM");
      expect(await worker.exit).toBe(0);

      const spans = lens.spans();
      expect(spans.map((span) => span.name).sort()).toEqual(
        ["analyze", "forecast", "ingest", "recommend", "report"].map((s) => `pipeline.${s}`),
      );
      const { traceId } = await readRun();
      expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceId]));
      expect(new Set(lens.serviceNames())).toEqual(new Set(["sisaku-pipeline"]));
      expect(lens.raw()).not.toMatch(/Warung|Rendang|Nasi/);
    } finally {
      await lens.close();
    }
  });

  it.each([
    [[], "--outlet"],
    [["--outlet", ids.outletA], "--date"],
    [["--date", "2026-03-01"], "--outlet"],
    [["--outlet", "Nowhere", "--date", "2026-03-01"], 'No outlet with the id or name "Nowhere"'],
    [["--outlet", ids.outletA, "--date", "soon"], "YYYY-MM-DD"],
    [["--outlet", ids.outletA, "--date", "2026-03-01", "--force"], "--force"],
  ])("pipeline:run %j is refused with a message, not a stack trace", async (args, message) => {
    const { code, output } = await command(args);
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(output).not.toMatch(/\n\s+at /);
  });

  it("pipeline:run says so when Redis cannot be reached, and creates no run", async () => {
    const before = (await db.select().from(agentRuns)).length;
    const { code, output } = await command(["--outlet", ids.outletA, "--date", "2026-03-09"], {
      ...settings,
      REDIS_URL: DEAD_REDIS,
    });
    expect(code).toBe(1);
    expect(output).toContain("Redis");
    expect(await db.select().from(agentRuns)).toHaveLength(before);
  });

  it("pipeline:run says so when Postgres cannot be reached", async () => {
    const { code, output } = await command(["--outlet", ids.outletA, "--date", "2026-03-09"], {
      ...settings,
      DATABASE_URL: "postgres://x:x@localhost:1/x",
    });
    expect(code).toBe(1);
    expect(output.trim()).toBe("Postgres at DATABASE_URL cannot be reached");
  });

  it.each([
    "REDIS_URL",
    "DATABASE_URL",
    "ANVIA_LENS_BASE_URL",
    "ANVIA_LENS_PUBLIC_KEY",
    "ANVIA_LENS_SECRET_KEY",
  ])("the worker refuses to start without %s", async (name) => {
    const { code, output } = await run("src/main.ts", [], without(name));
    expect(code).not.toBe(0);
    expect(output).toContain(`${name} `);
  });

  it.each([
    ["Redis", { REDIS_URL: DEAD_REDIS }, /Redis at REDIS_URL cannot be reached/],
    [
      "Postgres",
      { DATABASE_URL: "postgres://x:x@127.0.0.1:1/x" },
      /Postgres at DATABASE_URL cannot be reached/,
    ],
    ["kitchen-mcp without a token", { KITCHEN_MCP_URL: DEAD_MCP }, /KITCHEN_MCP_TOKEN/],
    ["kitchen-mcp", { KITCHEN_MCP_URL: DEAD_MCP, KITCHEN_MCP_TOKEN: "t", ...PRIVATE }, NO_MCP],
    ["impact-mcp", { IMPACT_MCP_URL: DEAD_MCP, IMPACT_MCP_TOKEN: "t", ...PRIVATE }, NO_MCP],
    ["Lens", { ANVIA_LENS_BASE_URL: "not a url" }, /Lens baseUrl must be an absolute/],
  ])("the worker refuses to start with a broken %s", async (_name, broken, message) => {
    const { code, output } = await run("src/main.ts", [], { ...settings, ...broken });
    expect(code).not.toBe(0);
    expect(output).toMatch(message);
  });
});
