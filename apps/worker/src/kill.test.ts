import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  agentRuns,
  pipelineJobResults,
  pipelineJobs,
  PIPELINE_STEPS,
  type PipelineStep,
} from "@sisaku/db";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { createPipelineRuns, PIPELINE_QUEUE, queueOptions } from "./index";
import { testRedis, testRedisUrl } from "./testing/redis";

// A worker process killed with SIGKILL in the middle of a step, as by a crash or a power cut.

const cwd = fileURLToPath(new URL("..", import.meta.url));

describe.skipIf(!testDbUrl || !testRedisUrl)("a killed worker", { timeout: 90_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;
  let queue: Queue;
  const children: ChildProcess[] = [];
  /** What every worker process of the test printed, in order. */
  let lines: string[] = [];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 100 });
    queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis));
  });
  afterEach(async () => {
    await Promise.all(children.splice(0).map(kill));
    await redis.clear();
    await db.delete(pipelineJobResults);
    await db.delete(pipelineJobs);
    await db.delete(agentRuns);
    lines = [];
  });
  afterAll(async () => {
    await runs?.close();
    await queue?.close();
    await redis?.close();
    await pool?.end();
  });

  async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  function startWorker(env: Record<string, string> = {}) {
    const child = spawn("node", ["--import", "tsx", "src/testing/killable-worker.ts"], {
      cwd,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        DATABASE_URL: testDbUrl!,
        REDIS_URL: testRedisUrl!,
        PIPELINE_REDIS_PREFIX: redis.redis.prefix,
        ...env,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let rest = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const parts = (rest + chunk.toString()).split("\n");
      rest = parts.pop()!;
      lines.push(...parts);
    });
    children.push(child);
    return child;
  }

  const count = (line: string) => lines.filter((printed) => printed === line).length;

  /** Starts a worker that hangs, and kills it once it has printed `line` (once more). */
  async function killOn(line: string, env: Record<string, string>) {
    const before = count(line);
    const worker = startWorker(env);
    await expect.poll(() => count(line), { timeout: 20_000 }).toBe(before + 1);
    await kill(worker);
  }

  async function readRun(runId: string) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    const jobs = await db.select().from(pipelineJobs).where(eq(pipelineJobs.runId, runId));
    const job = (step: PipelineStep) => jobs.find((j) => j.step === step)!;
    return { run: run!, job, statuses: PIPELINE_STEPS.map((step) => job(step).status) };
  }

  async function expectStatus(runId: string, status: "succeeded" | "failed") {
    await expect
      .poll(async () => (await readRun(runId)).run.status, { timeout: 20_000 })
      .toBe(status);
  }

  const start = () => runs.startManual({ outlet: ids.outletA, date: "2026-03-01" });

  it("has only the step it was running run again by the next worker", async () => {
    const { runId } = await start();
    await killOn("start forecast", { HANG_STEP: "forecast" });
    expect((await readRun(runId)).statuses).toEqual([
      "succeeded",
      "succeeded",
      "running",
      "pending",
      "pending",
    ]);

    startWorker();
    await expectStatus(runId, "succeeded");
    expect(Object.fromEntries(PIPELINE_STEPS.map((s) => [s, count(`start ${s}`)]))).toEqual({
      ingest: 1,
      analyze: 1,
      forecast: 2,
      recommend: 1,
      report: 1,
    });
    const { job, statuses } = await readRun(runId);
    expect(statuses).toEqual(Array(5).fill("succeeded"));
    expect(PIPELINE_STEPS.map((step) => job(step).attempts)).toEqual([1, 1, 2, 1, 1]);
  });

  it("is given up on after four kills in the same step, which fails the run", async () => {
    const { runId } = await start();
    for (let i = 0; i < 4; i++) await killOn("start forecast", { HANG_STEP: "forecast" });
    startWorker();
    await expectStatus(runId, "failed");
    expect(count("start forecast")).toBe(4);
    const { run, job, statuses } = await readRun(runId);
    expect(statuses).toEqual(["succeeded", "succeeded", "failed", "pending", "pending"]);
    const message = "Its worker died 4 times while running it";
    expect(run.error).toBe(`forecast: ${message}`);
    expect(job("forecast")).toMatchObject({ attempts: 4, error: message });

    // An operator's retry is a new chance.
    const failed = await queue.getJob(`${runId}-forecast`);
    await failed!.retry("failed");
    await expectStatus(runId, "succeeded");
    expect(count("start forecast")).toBe(5);
  });

  it("is given up on after four kills, and a step with a fallback is degraded", async () => {
    const env = { FALLBACK_STEP: "forecast" };
    const { runId } = await start();
    for (let i = 0; i < 4; i++) await killOn("start forecast", { ...env, HANG_STEP: "forecast" });
    // Killed in the fallback too: it starts again.
    await killOn("fallback forecast", { ...env, HANG_FALLBACK: "1" });
    startWorker(env);
    await expectStatus(runId, "succeeded");
    expect(count("start forecast")).toBe(4);
    expect(count("fallback forecast")).toBe(2);
    const { job, statuses } = await readRun(runId);
    expect(statuses).toEqual(["succeeded", "succeeded", "degraded", "succeeded", "succeeded"]);
    expect(job("forecast")).toMatchObject({
      attempts: 4,
      error: "Its worker died 4 times while running it",
    });
  });

  it("does not run a fallback forever that kills its worker", async () => {
    const env = { FALLBACK_STEP: "forecast" };
    const { runId } = await start();
    for (let i = 0; i < 4; i++) await killOn("start forecast", { ...env, HANG_STEP: "forecast" });
    for (let i = 0; i < 4; i++) await killOn("fallback forecast", { ...env, HANG_FALLBACK: "1" });
    startWorker(env);
    await expectStatus(runId, "failed");
    expect(count("fallback forecast")).toBe(4);
    expect((await readRun(runId)).job("forecast").error).toBe(
      "Its worker died 4 times while running it; its fallback failed: its worker died 4 times",
    );
  });
});
