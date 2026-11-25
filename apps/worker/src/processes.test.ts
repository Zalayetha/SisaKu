import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { agentRuns } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { testRedis, testRedisUrl } from "./testing/redis";

// The worker and the pipeline:run command as real processes, without the repo's .env.

const cwd = fileURLToPath(new URL("..", import.meta.url));
const DEAD_MCP = "http://127.0.0.1:1/mcp";
const PRIVATE = { MCP_SSRF_PROTECTION: "disabled" };
const NO_MCP = /Version negotiation probe failed: fetch failed/;
const DEAD_REDIS = "redis://127.0.0.1:1";

describe.skipIf(!testDbUrl || !testRedisUrl)("worker processes", { timeout: 60_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let redis: ReturnType<typeof testRedis>;
  let settings: Record<string, string>;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
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

  type Attribute = { key: string; value: { stringValue?: string; intValue?: number } };
  type Export = {
    resourceSpans: {
      resource: { attributes: Attribute[] };
      scopeSpans: { spans: { traceId: string; name: string; attributes: Attribute[] }[] }[];
    }[];
  };

  it("the worker sends one trace per run to Lens, without content, and flushes it on SIGTERM", async () => {
    const received: { authorization: string | undefined; body: string }[] = [];
    const lens: Server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        received.push({ authorization: request.headers.authorization, body });
        response.setHeader("content-type", "application/json").end("{}");
      });
    });
    await new Promise<void>((resolve) => lens.listen(0, "127.0.0.1", resolve));
    const { port } = lens.address() as AddressInfo;
    try {
      const { output } = await command(["--outlet", "Warung Test", "--date", "2026-03-02"]);
      const runId = /[0-9a-f]{8}-[0-9a-f-]{27}/.exec(output)![0];
      const worker = start("src/main.ts", [], {
        ...settings,
        ANVIA_LENS_BASE_URL: `http://127.0.0.1:${port}`,
      });
      const readRun = async () =>
        (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;
      await expect
        .poll(async () => (await readRun()).status, { timeout: 30_000 })
        .toBe("succeeded");
      // At once, so the spans are still waiting for the next batch.
      worker.child.kill("SIGTERM");
      expect(await worker.exit).toBe(0);

      const exports = received.map(({ body }) => JSON.parse(body) as Partial<Export>);
      const resources = exports.flatMap((e) => e.resourceSpans ?? []);
      const spans = resources.flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans));
      expect(spans.map((span) => span.name).sort()).toEqual(
        ["analyze", "forecast", "ingest", "recommend", "report"].map((s) => `pipeline.${s}`),
      );
      const { traceId } = await readRun();
      expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceId]));
      expect(resources[0]!.resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "sisaku-pipeline" },
      });
      for (const { attributes } of spans) {
        const keys = attributes.map(({ key }) => key);
        expect(keys).toContain("anvia.run.metadata.attempt");
        expect(keys).not.toContain("anvia.pipeline.input");
        expect(keys).not.toContain("anvia.pipeline.output");
      }
      expect(JSON.stringify(received)).not.toMatch(/Warung|Rendang|Nasi/);
    } finally {
      await new Promise((resolve) => lens.close(resolve));
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
