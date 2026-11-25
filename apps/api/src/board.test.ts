import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import {
  createPipelineRuns,
  createPipelineWorker,
  DEFAULT_STEPS,
  PermanentError,
  PIPELINE_QUEUE,
  queueOptions,
  type StepDefinition,
} from "@sisaku/worker";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { testRedis, testRedisUrl } from "../../worker/src/testing/redis";
import { deleteRuns, expectStatus, readRun } from "../../worker/src/testing/runs";
import { createBoardApp } from "./board";

const USER = "operator";
const PASSWORD = "correct horse";
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const AUTHORIZATION = basic(USER, PASSWORD);

describe.skipIf(!testDbUrl || !testRedisUrl)("Bull Board", { timeout: 30_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;
  let queue: Queue;
  let app: ReturnType<typeof createBoardApp>;
  const workers: ReturnType<typeof createPipelineWorker>[] = [];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 20 });
    queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis));
    app = createBoardApp({ queue, user: USER, password: PASSWORD });
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop(500)));
    await redis.clear();
    await deleteRuns(db);
  });
  afterAll(async () => {
    await runs?.close();
    await queue?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  const start = () => runs.startManual({ outlet: ids.outletA, date: "2026-03-01" });

  function startWorker(steps: Partial<Record<string, StepDefinition>> = {}) {
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      redis: redis.redis,
      steps: { ...DEFAULT_STEPS, ...steps },
      log: () => undefined,
    });
    workers.push(worker);
    return worker;
  }

  /** As the board's own page asks. */
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: AUTHORIZATION,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
        ...(init.headers as Record<string, string>),
      },
    });

  /** The path of a script the page loads. */
  async function scriptPath() {
    const page = await (await request("/")).text();
    const script = /<script[^>]+src="([^"]+)"/.exec(page)![1]!;
    return new URL(script, "http://board/").pathname;
  }

  describe("without the right credentials", () => {
    const refused = [
      ["none", undefined],
      ["a wrong password", basic(USER, "wrong")],
      ["a wrong user", basic("someone", PASSWORD)],
      ["no password", basic(USER, "")],
      ["nothing at all in them", basic("", "")],
      ["another scheme", `Bearer ${PASSWORD}`],
      ["something malformed", "Basic %%%"],
    ] as const;

    it.each(refused)("refuses every route with %s", async (_what, authorization) => {
      const { runId } = await start();
      const script = await scriptPath();
      const job = `/api/queues/${PIPELINE_QUEUE}/${runId}-ingest`;
      const routes: [string, string][] = [
        ["GET", "/"],
        ["GET", `/queue/${PIPELINE_QUEUE}`],
        ["GET", script],
        ["GET", "/api/queues"],
        ["GET", "/api/redis/stats"],
        ["GET", job],
        ["GET", "/api/job-schedulers"],
        ["PUT", `${job}/retry`],
        ["PUT", `/api/queues/${PIPELINE_QUEUE}/retry/failed`],
        ["PUT", `/api/queues/${PIPELINE_QUEUE}/obliterate`],
        ["PUT", `${job}/clean`],
        ["PUT", `/api/queues/${PIPELINE_QUEUE}/empty`],
        ["PUT", `/api/queues/${PIPELINE_QUEUE}/pause`],
        ["PUT", "/api/queues/pause"],
        ["POST", `/api/queues/${PIPELINE_QUEUE}/add`],
        ["GET", "/no-such-page"],
      ];
      for (const [method, path] of routes) {
        const response = await app.request(path, {
          method,
          ...(authorization ? { headers: { authorization } } : {}),
        });
        expect([method, path, response.status]).toEqual([method, path, 401]);
        expect(await response.text()).not.toContain(runId);
      }
      expect(await queue.isPaused()).toBe(false);
      expect(await queue.getJob(`${runId}-ingest`)).toBeDefined();
    });
  });

  it("serves its page and its scripts", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/html/);
    const script = await request(await scriptPath());
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
  });

  it("shows the queue's jobs with their errors, while no worker is running", async () => {
    const failing: StepDefinition = {
      name: "analyze",
      output: z.unknown(),
      run: async () => {
        throw new PermanentError("the model does not exist");
      },
    };
    const { runId } = await start();
    startWorker({ analyze: failing });
    await expectStatus(db, runId, "failed");
    await workers.splice(0)[0]!.stop();
    const waiting = await runs.startManual({ outlet: ids.outletB, date: "2026-03-01" });

    const listed = await request(`/api/queues?activeQueue=${PIPELINE_QUEUE}&status=failed`);
    expect(listed.status).toBe(200);
    const { queues } = (await listed.json()) as {
      queues: {
        name: string;
        counts: Record<string, number>;
        jobs: { id: string; name: string; failedReason: string }[];
      }[];
    };
    expect(queues.map((q) => q.name)).toEqual([PIPELINE_QUEUE]);
    expect(queues[0]!.counts).toMatchObject({ completed: 1, failed: 1, waiting: 1 });
    expect(queues[0]!.jobs).toEqual([
      expect.objectContaining({
        id: `${runId}-analyze`,
        name: "analyze",
        failedReason: "the model does not exist",
      }),
    ]);
    const job = await request(`/api/queues/${PIPELINE_QUEUE}/${waiting.runId}-ingest`);
    expect(await job.json()).toMatchObject({ job: { name: "ingest" }, status: "waiting" });
  });

  it("resumes a failed run when its job is retried from the board", async () => {
    const starts = { ingest: 0, analyze: 0 };
    const counted = (name: keyof typeof starts, fails: number): StepDefinition => ({
      name,
      output: z.object({ ok: z.literal(true) }),
      run: async () => {
        if (++starts[name] <= fails) throw new Error(`failure ${starts[name]}`);
        return { ok: true };
      },
    });
    const { runId } = await start();
    startWorker({ ingest: counted("ingest", 0), analyze: counted("analyze", 4) });
    await expectStatus(db, runId, "failed");

    const path = `/api/queues/${PIPELINE_QUEUE}/${runId}-analyze/retry`;
    expect((await request(path, { method: "PUT" })).status).toBe(204);
    await expectStatus(db, runId, "succeeded");
    expect(starts).toEqual({ ingest: 1, analyze: 5 });
    expect((await readRun(db, runId)).statuses).toEqual(Array(5).fill("succeeded"));
  });

  it("does not take orders from another website through the operator's browser", async () => {
    const { runId } = await start();
    // What a form or a script on another site can send with the browser's saved password.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      const response = await request(`/api/queues/${PIPELINE_QUEUE}/add`, {
        method: "POST",
        headers: {
          origin: "https://elsewhere.example",
          "sec-fetch-site": "cross-site",
          ...(type ? { "content-type": type } : {}),
        },
        body: JSON.stringify({ name: "ingest", data: { runId, step: "ingest" } }),
      });
      expect(response.status).toBe(403);
    }
    expect(await queue.getWaitingCount()).toBe(1);
  });

  describe("as a process", () => {
    const cwd = fileURLToPath(new URL("..", import.meta.url));

    async function freePort() {
      const server = createServer().listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      server.close();
      return port;
    }

    function startApi(env: Record<string, string>) {
      const child = spawn("node", ["--import", "tsx", "src/main.ts"], {
        cwd,
        env: {
          PATH: process.env.PATH!,
          HOME: process.env.HOME!,
          REDIS_URL: testRedisUrl!,
          PIPELINE_REDIS_PREFIX: redis.redis.prefix,
          BULL_BOARD_PASSWORD: PASSWORD,
          ...env,
        },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
      return { child, exit, output: () => output };
    }

    it("listens on loopback only, and stops on SIGTERM", async () => {
      const port = await freePort();
      const api = startApi({ API_PORT: String(port) });
      try {
        await expect.poll(api.output, { timeout: 20_000 }).toContain(`http://127.0.0.1:${port}`);
        const url = `http://127.0.0.1:${port}/api/queues`;
        expect((await fetch(url)).status).toBe(401);
        const headers = { authorization: AUTHORIZATION };
        await start();
        const listed = (await (await fetch(url, { headers })).json()) as {
          queues: { name: string; counts: { waiting: number } }[];
        };
        expect(listed.queues).toEqual([
          expect.objectContaining({
            name: PIPELINE_QUEUE,
            counts: expect.objectContaining({ waiting: 1 }),
          }),
        ]);
        expect((await fetch(new URL(await scriptPath(), url), { headers })).status).toBe(200);
        expect(api.output()).not.toContain(PASSWORD);
        api.child.kill("SIGTERM");
        expect(await api.exit).toBe(0);
      } finally {
        api.child.kill("SIGKILL");
      }
    });

    it.each([
      ["without a password", { BULL_BOARD_PASSWORD: "" }, "BULL_BOARD_PASSWORD is not set"],
      ["with a blank password", { BULL_BOARD_PASSWORD: "  " }, "BULL_BOARD_PASSWORD is not set"],
      ["without Redis's address", { REDIS_URL: "" }, "REDIS_URL is not set"],
      [
        "when Redis cannot be reached",
        { REDIS_URL: "redis://127.0.0.1:1" },
        "Redis at REDIS_URL cannot be reached",
      ],
      ["with a port that is not one", { API_PORT: "board" }, "API_PORT is not a port"],
    ])("refuses to start %s", async (_how, env, message) => {
      const api = startApi(env);
      expect(await api.exit).not.toBe(0);
      expect(api.output()).toContain(message);
    });
  });
});
