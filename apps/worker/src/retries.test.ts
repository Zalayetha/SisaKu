import type { McpClientGroup } from "@anvia/mcp";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { agentRuns, forecasts, pipelineJobResults, pipelineJobs } from "@sisaku/db";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineRuns,
  createPipelineWorker,
  PermanentError,
  PIPELINE_QUEUE,
  queueOptions,
  type PipelineWorkerDeps,
  type StepContext,
  type StepDefinition,
} from "./index";
import { TEST_STEPS } from "./testing/steps";
import { testRedis, testRedisUrl } from "./testing/redis";
import {
  deleteRuns,
  expectStatus as expectRunStatus,
  readRun as readRunFrom,
} from "./testing/runs";

const DATE = "2026-03-01";

/** A step whose every attempt is scripted: it takes the next one, and repeats the last. */
function scriptedStep(
  name: StepDefinition["name"],
  attempts: ((context: StepContext) => Promise<unknown>)[],
  extra: Partial<StepDefinition> = {},
) {
  const started: number[] = [];
  const step: StepDefinition = {
    name,
    output: z.object({ from: z.string() }),
    run: (context) => {
      started.push(Date.now());
      return attempts[Math.min(started.length, attempts.length) - 1]!(context);
    },
    ...extra,
  };
  return { step, started };
}

const succeeds = async () => ({ from: "run" });
const hangs = () => new Promise<never>(() => {});
const fails = (message: string) => async () => {
  throw new Error(message);
};
const permanent = async () => {
  throw new PermanentError("permanent");
};
const failsFourTimes = ["1st", "2nd", "3rd", "4th"].map(fails);

describe.skipIf(!testDbUrl || !testRedisUrl)("pipeline retries", { timeout: 20_000 }, () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let redis: ReturnType<typeof testRedis>;
  let runs: ReturnType<typeof createPipelineRuns>;
  const workers: ReturnType<typeof createPipelineWorker>[] = [];

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    mcp = await connectInMemoryServers(db);
    redis = testRedis();
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 100 });
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop(1_000)));
    await redis.clear();
    await db.delete(forecasts);
    await deleteRuns(db);
  });

  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  const SHORT = { stalledAfterMs: 200 };

  /** Runs the step until its `nth` start, and leaves the worker dead in it. */
  async function startAndKill({ step, started }: ReturnType<typeof scriptedStep>, nth: number) {
    const worker = startWorker([step], SHORT);
    await expect.poll(() => started.length, { timeout: 5_000 }).toBe(nth);
    workers.splice(workers.indexOf(worker), 1);
    await worker.stop(0);
  }

  const start = () => runs.startManual({ outlet: ids.outletA, date: DATE });

  function startWorker(steps: StepDefinition[], extra: Partial<PipelineWorkerDeps> = {}) {
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      redis: redis.redis,
      steps: { ...TEST_STEPS, ...Object.fromEntries(steps.map((s) => [s.name, s])) },
      log: () => undefined,
      ...extra,
    });
    workers.push(worker);
    return worker;
  }

  const readRun = (runId: string) => readRunFrom(db, runId);
  const expectStatus = (runId: string, status: "succeeded" | "failed") =>
    expectRunStatus(db, runId, status);

  it("retries a failed step alone, and keeps it running until its attempts run out", async () => {
    const ingest = scriptedStep("ingest", [succeeds]);
    let seenBetween: unknown;
    const analyze = scriptedStep("analyze", [
      fails("model overloaded"),
      async ({ run }) => {
        const between = await readRun(run.id);
        seenBetween = {
          run: between.run.status,
          status: between.job("analyze").status,
          attempts: between.job("analyze").attempts,
          error: between.job("analyze").error,
        };
        throw new Error("model still overloaded");
      },
      succeeds,
    ]);
    const { runId } = await start();
    startWorker([ingest.step, analyze.step]);

    await expectStatus(runId, "succeeded");
    expect(seenBetween).toEqual({
      run: "running",
      status: "running",
      attempts: 2, // this one
      error: "model overloaded",
    });
    expect(ingest.started).toHaveLength(1);
    expect(analyze.started).toHaveLength(3);
    const { job, run } = await readRun(runId);
    expect(run.error).toBeNull();
    expect(job("analyze")).toMatchObject({
      status: "succeeded",
      attempts: 3,
      error: "model still overloaded", // why it took three attempts
      output: { from: "run" },
    });
  });

  it("waits longer before each retry, and fails the run after four attempts", async () => {
    const analyze = scriptedStep("analyze", [...failsFourTimes]);
    const { runId } = await start();
    startWorker([analyze.step]);

    await expectStatus(runId, "failed");
    expect(analyze.started).toHaveLength(4);
    // 100, 200 and 400 ms here: the same doubling as 30, 60 and 120 seconds.
    const waits = analyze.started.slice(1).map((time, i) => time - analyze.started[i]!);
    for (const [i, expected] of [100, 200, 400].entries()) {
      expect(waits[i]).toBeGreaterThanOrEqual(expected - 5);
    }
    const { run, job, statuses } = await readRun(runId);
    expect(run).toMatchObject({ error: "analyze: 4th", finishedAt: expect.any(Date) });
    expect(job("analyze")).toMatchObject({ attempts: 4, error: "4th", output: undefined });
    expect(statuses).toEqual(["succeeded", "failed", "pending", "pending", "pending"]);
  });

  it("retries after 30 seconds at first, and is pending until then", async () => {
    const production = createPipelineRuns({ db, redis: redis.redis });
    const queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis));
    try {
      const { runId } = await production.startManual({ outlet: ids.outletA, date: DATE });
      startWorker([scriptedStep("ingest", [fails("down")]).step]);
      await expect
        .poll(async () => (await queue.getDelayed()).map((job) => [job.data, job.delay]))
        .toEqual([[{ runId, step: "ingest" }, 30_000]]);
      const { run, job } = await readRun(runId);
      expect(run.status).toBe("running");
      expect(job("ingest")).toMatchObject({ status: "pending", attempts: 1, error: "down" });
      await expect(start()).rejects.toThrow(/already in progress/);
    } finally {
      await production.close();
      await queue.close();
    }
  });

  it("stops an attempt at the step's time limit and retries it", async () => {
    let aborted = false;
    const listens = ({ signal }: StepContext) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      );
    const analyze = scriptedStep("analyze", [listens, hangs, succeeds], { timeLimitMs: 150 });
    const { runId } = await start();
    startWorker([analyze.step]);

    await expectStatus(runId, "succeeded");
    expect(aborted).toBe(true);
    expect(analyze.started).toHaveLength(3);
    expect((await readRun(runId)).job("analyze")).toMatchObject({
      attempts: 3,
      error: "Step analyze reached its time limit of 150 ms",
    });
  });

  it("drops what a timed-out attempt returns late", async () => {
    let finishLate = () => {};
    const late = () =>
      new Promise<unknown>((resolve) => (finishLate = () => resolve({ from: "late" })));
    const analyze = scriptedStep(
      "analyze",
      [
        late,
        async () => {
          finishLate();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { from: "retry" };
        },
      ],
      { timeLimitMs: 200 },
    );
    const { runId } = await start();
    startWorker([analyze.step]);
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("analyze").output).toEqual({ from: "retry" });
  });

  it("does not accept what a step returns when it is told its time is up", async () => {
    const givesUp = ({ signal }: StepContext) =>
      new Promise<unknown>((resolve) =>
        signal.addEventListener("abort", () => resolve({ from: "half the work" })),
      );
    const analyze = scriptedStep("analyze", [givesUp, succeeds], { timeLimitMs: 150 });
    const { runId } = await start();
    startWorker([analyze.step]);
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("analyze")).toMatchObject({
      attempts: 2,
      output: { from: "run" },
    });
  });

  it("counts kills and failures together", async () => {
    const ingest = scriptedStep("ingest", [hangs, fails("2nd"), hangs, fails("4th"), succeeds]);
    const { runId } = await start();
    await startAndKill(ingest, 1);
    await startAndKill(ingest, 3);
    startWorker([ingest.step], SHORT);
    await expectStatus(runId, "failed");
    expect(ingest.started).toHaveLength(4);
    expect((await readRun(runId)).job("ingest")).toMatchObject({ attempts: 4, error: "4th" });
  });

  it("goes back to its fallback, not to the step, when killed during the fallback", async () => {
    let fallbacks = 0;
    const ingest = scriptedStep("ingest", [...failsFourTimes, succeeds], {
      fallback: async () => (++fallbacks === 1 ? hangs() : { from: "fallback" }),
    });
    const { runId } = await start();
    const worker = startWorker([ingest.step], SHORT);
    await expect.poll(() => fallbacks, { timeout: 5_000 }).toBe(1);
    workers.splice(workers.indexOf(worker), 1);
    await worker.stop(0);
    startWorker([ingest.step], SHORT);
    await expectStatus(runId, "succeeded");
    expect(ingest.started).toHaveLength(4);
    expect((await readRun(runId)).job("ingest")).toMatchObject({
      status: "degraded",
      attempts: 4,
      error: "Interrupted on attempt 4 of 4; last error: 4th",
      output: { from: "fallback" },
    });
  });

  it("is not degraded by a worker thought dead while its replacement works on it", async () => {
    let failLate = () => {};
    let finish = () => {};
    let fallbacks = 0;
    const ingest = scriptedStep(
      "ingest",
      [
        () => new Promise((_, reject) => (failLate = () => reject(new PermanentError("late")))),
        () => new Promise((resolve) => (finish = () => resolve({ from: "replacement" }))),
      ],
      {
        fallback: async () => {
          fallbacks++;
          return { from: "fallback" };
        },
      },
    );
    const { runId } = await start();
    await startAndKill(ingest, 1);
    startWorker([ingest.step], SHORT);
    await expect.poll(() => ingest.started.length, { timeout: 5_000 }).toBe(2);
    failLate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fallbacks).toBe(0);
    finish();
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("ingest")).toMatchObject({
      status: "succeeded",
      output: { from: "replacement" },
    });
  });

  it.each([
    ["an earlier", 1, "succeeded", 2],
    ["the last", 4, "degraded", 4],
  ])(
    "takes an error before the step runs for a failed attempt (%s one)",
    async (_which, failing, status, attempts) => {
      // Reading an earlier output fails as a lost connection would; its schema is read through.
      let reads = 0;
      const ingest = scriptedStep("ingest", [succeeds], {
        output: z.object({ from: z.string() }).refine(() => {
          // Checked twice when it is saved, then once per read.
          if (++reads > 2 && reads <= 2 + failing) throw new Error("connection lost");
          return true;
        }),
      });
      const analyze = scriptedStep("analyze", [succeeds], {
        fallback: async () => ({ from: "fallback" }),
      });
      const { runId } = await start();
      startWorker([ingest.step, analyze.step]);
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("analyze")).toMatchObject({
        status,
        attempts,
        error: "connection lost",
      });
    },
  );

  it("drops the result of a worker thought dead while its replacement works on it", async () => {
    let finishLate = () => {};
    let finish = () => {};
    const ingest = scriptedStep("ingest", [
      () => new Promise((resolve) => (finishLate = () => resolve({ from: "late" }))),
      () => new Promise((resolve) => (finish = () => resolve({ from: "replacement" }))),
    ]);
    const { runId } = await start();
    await startAndKill(ingest, 1);
    startWorker([ingest.step], SHORT);
    await expect.poll(() => ingest.started.length, { timeout: 5_000 }).toBe(2);
    finishLate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readRun(runId)).job("ingest").status).toBe("running");
    finish();
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("ingest").output).toEqual({ from: "replacement" });
  });

  it("is not set back by the late failure of a worker thought dead", async () => {
    let failLate = () => {};
    let finish = () => {};
    const ingest = scriptedStep("ingest", [
      () => new Promise((_, reject) => (failLate = () => reject(new Error("late")))),
      () => new Promise((resolve) => (finish = () => resolve({ from: "run" }))),
    ]);
    const { runId } = await start();
    startWorker([ingest.step], { stalledAfterMs: 200 });
    await expect.poll(() => ingest.started.length).toBe(1);
    await workers.splice(0)[0]!.stop(0);
    startWorker([ingest.step], { stalledAfterMs: 200 });
    await expect.poll(() => ingest.started.length, { timeout: 5_000 }).toBe(2);

    failLate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readRun(runId)).job("ingest")).toMatchObject({
      status: "running",
      attempts: 2,
      error: null,
    });
    finish();
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("ingest").output).toEqual({ from: "run" });
  });

  it("retries a step that throws at once, and its time limit does nothing later", async () => {
    const throwsNow = () => {
      throw new Error("threw before its first await");
    };
    const analyze = scriptedStep("analyze", [throwsNow, succeeds], { timeLimitMs: 300 });
    const { runId } = await start();
    startWorker([analyze.step]);
    await expectStatus(runId, "succeeded");
    // An unhandled rejection here fails the test run.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it("gives a permanent error one attempt", async () => {
    const analyze = scriptedStep("analyze", [
      async () => {
        throw new PermanentError("the outlet has no menu");
      },
    ]);
    const { runId } = await start();
    startWorker([analyze.step]);
    await expectStatus(runId, "failed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(analyze.started).toHaveLength(1);
    expect((await readRun(runId)).job("analyze")).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "the outlet has no menu",
    });
  });

  it("does not retry a step whose earlier output no longer matches its schema", async () => {
    const analyze = scriptedStep("analyze", [
      async ({ run }) => {
        const { job } = await readRun(run.id);
        await db
          .update(pipelineJobResults)
          .set({ output: { wrong: true } })
          .where(eq(pipelineJobResults.jobId, job("ingest").id));
        return { from: "run" };
      },
    ]);
    const forecast = scriptedStep("forecast", [succeeds]);
    const { runId } = await start();
    startWorker([analyze.step, forecast.step]);
    await expectStatus(runId, "failed");
    const { job } = await readRun(runId);
    expect(job("forecast")).toMatchObject({ status: "failed", attempts: 1 });
    expect(job("forecast").error).toMatch(/^The saved output of ingest does not match its schema/);
    expect(forecast.started).toHaveLength(0);
  });

  describe("a job BullMQ should not have", () => {
    let queue: Queue;
    beforeAll(() => (queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis))));
    afterAll(() => queue?.close());

    async function failedJob(id: string) {
      await expect.poll(() => queue.getJobState(id), { timeout: 5_000 }).toBe("failed");
      return (await queue.getJob(id))!;
    }

    it("fails at once when its run no longer exists", async () => {
      const { runId } = await start();
      await db.delete(pipelineJobs);
      await db.delete(agentRuns);
      startWorker([]);
      const job = await failedJob(`${runId}-ingest`);
      expect(job.failedReason).toBe(`Pipeline run ${runId} not found`);
      expect(job.attemptsMade).toBe(1);
    });

    it.each([
      ["no run id", { step: "ingest" }],
      ["a malformed run id", { runId: "42", step: "ingest" }],
      ["an unknown step", { runId: ids.outletA, step: "dance" }],
    ])("fails at once with %s", async (_what, data) => {
      const logged: string[] = [];
      startWorker([], { log: (message) => logged.push(message) });
      const { id } = await queue.add("ingest", data, { attempts: 4 });
      const job = await failedJob(id!);
      expect(job.failedReason).toMatch(/^Not a pipeline job: /);
      expect(job.attemptsMade).toBe(1);
      // There is no record to write the failure to, which is not a failure of its own.
      expect(logged.join()).not.toMatch(/Could not record/);
    });
  });

  describe("a step with a fallback", () => {
    it("is degraded once its attempts run out, and the run succeeds", async () => {
      let given: { context: StepContext; error: unknown } | undefined;
      const forecast = scriptedStep("forecast", failsFourTimes, {
        fallback: async (context, error) => {
          given = { context, error };
          return { from: "fallback" };
        },
      });
      let seenByRecommend: unknown;
      const recommend = scriptedStep("recommend", [
        async ({ outputs }) => {
          seenByRecommend = outputs.forecast;
          return { from: "run" };
        },
      ]);
      const { runId } = await start();
      startWorker([forecast.step, recommend.step]);

      await expectStatus(runId, "succeeded");
      expect(forecast.started).toHaveLength(4);
      const { run, job, statuses } = await readRun(runId);
      expect(statuses).toEqual(["succeeded", "succeeded", "degraded", "succeeded", "succeeded"]);
      expect(run.error).toBeNull();
      expect(job("forecast")).toMatchObject({
        attempts: 4,
        error: "4th",
        output: { from: "fallback" },
        finishedAt: expect.any(Date),
      });
      expect(seenByRecommend).toEqual({ from: "fallback" });
      expect(given!.error).toMatchObject({ message: "4th" });
      expect(given!.context.run).toMatchObject({ id: runId, businessDate: DATE });
      expect(given!.context.outputs).toEqual({
        ingest: expect.objectContaining({ gaps: [] }),
        analyze: expect.objectContaining({ spikes: [] }),
      });
      expect(given!.context.trace.traceId).toBe(run.traceId);
      expect(given!.context.signal.aborted).toBe(false);
    });

    it("uses it when the last step of the run cannot finish either", async () => {
      const report = scriptedStep("report", [fails("no")], {
        fallback: async () => ({ from: "fallback" }),
      });
      const { runId } = await start();
      startWorker([report.step]);
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("report").status).toBe("degraded");
    });

    it("uses it at once after a permanent error", async () => {
      const forecast = scriptedStep(
        "forecast",
        [
          async () => {
            throw new PermanentError("the model does not exist");
          },
        ],
        { fallback: async () => ({ from: "fallback" }) },
      );
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("forecast")).toMatchObject({
        status: "degraded",
        attempts: 1,
        error: "the model does not exist",
      });
    });

    it.each([
      ["throws", fails("no baseline"), /^4th; its fallback failed: no baseline$/],
      ["breaks the step's schema", async () => ({ from: 7 }), /^4th; its fallback failed: .*from/s],
      [
        "never finishes",
        () => new Promise<never>(() => {}),
        /^4th; its fallback failed: Step forecast reached its time limit of 200 ms$/,
      ],
    ])("fails when its fallback %s", async (_how, fallback, message) => {
      const forecast = scriptedStep("forecast", failsFourTimes, {
        fallback,
        timeLimitMs: 200,
      });
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "failed");
      const { job } = await readRun(runId);
      expect(job("forecast")).toMatchObject({ status: "failed", attempts: 4, output: undefined });
      expect(job("forecast").error).toMatch(message);
    });
  });

  describe("retrying a failed job", () => {
    let queue: Queue;
    beforeAll(() => (queue = new Queue(PIPELINE_QUEUE, queueOptions(redis.redis))));
    afterAll(() => queue?.close());

    /** As Bull Board does it. */
    async function retry(runId: string, step: StepDefinition["name"]) {
      const job = await queue.getJob(`${runId}-${step}`);
      await job!.retry("failed");
    }

    it("sets the run back to running, reruns only that step, and finishes the run", async () => {
      const ingest = scriptedStep("ingest", [succeeds]);
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      const analyze = scriptedStep("analyze", [
        ...failsFourTimes,
        async () => {
          await released;
          return { from: "run" };
        },
      ]);
      const report = scriptedStep("report", [succeeds]);
      const { runId } = await start();
      startWorker([ingest.step, analyze.step, report.step]);
      await expectStatus(runId, "failed");

      await retry(runId, "analyze");
      await expect.poll(() => analyze.started.length).toBe(5);
      const during = await readRun(runId);
      expect(during.run).toMatchObject({ status: "running", error: null, finishedAt: null });
      expect(during.job("analyze")).toMatchObject({ status: "running", finishedAt: null });
      await expect(start()).rejects.toThrow(/already in progress/);
      release();

      await expectStatus(runId, "succeeded");
      expect(ingest.started).toHaveLength(1);
      expect(report.started).toHaveLength(1);
      const { run, job, statuses } = await readRun(runId);
      expect(statuses).toEqual(Array(5).fill("succeeded"));
      expect(run).toMatchObject({ error: null, finishedAt: expect.any(Date) });
      expect(job("analyze").attempts).toBe(1); // since the retry
    });

    it("counts kills anew, so a kill after the retry is not the end of it", async () => {
      const ingest = scriptedStep("ingest", [hangs, hangs, hangs, hangs, hangs, succeeds]);
      const { runId } = await start();
      for (let nth = 1; nth <= 4; nth++) await startAndKill(ingest, nth);
      startWorker([ingest.step], SHORT);
      await expectStatus(runId, "failed");
      expect(ingest.started).toHaveLength(4);
      await workers.splice(0)[0]!.stop();

      await retry(runId, "ingest");
      await startAndKill(ingest, 5);
      startWorker([ingest.step], SHORT);
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("ingest").attempts).toBe(2);
    });

    it("is not undone by the failure before it being recorded late", async () => {
      let delayNext = false;
      let recordNow = () => {};
      const delayed = new Promise<void>((resolve) => (recordNow = resolve));
      // The first transaction after the attempt failed is the one that records the failure.
      const slowDb = new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (typeof value !== "function") return value;
          if (key !== "transaction" || !delayNext) return value.bind(target);
          delayNext = false;
          return async (work: Parameters<typeof db.transaction>[0]) => {
            await delayed;
            return target.transaction(work);
          };
        },
      });
      let finish = () => {};
      const analyze = scriptedStep("analyze", [
        async () => {
          delayNext = true;
          throw new PermanentError("1st");
        },
        () => new Promise((resolve) => (finish = () => resolve({ from: "run" }))),
      ]);
      const { runId } = await start();
      startWorker([analyze.step], { db: slowDb });
      await expect.poll(() => queue.getJobState(`${runId}-analyze`)).toBe("failed");
      await retry(runId, "analyze");
      await expect.poll(() => analyze.started.length).toBe(2);

      recordNow();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await readRun(runId)).run.status).toBe("running");
      finish();
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("analyze").output).toEqual({ from: "run" });
    });

    it("uses the fallback when the retry fails", async () => {
      let fallbacks = 0;
      const forecast = scriptedStep("forecast", [...failsFourTimes, fails("5th")], {
        fallback: async () => {
          if (++fallbacks === 1) throw new Error("no baseline yet");
          return { from: "fallback" };
        },
      });
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "failed");
      await retry(runId, "forecast");
      await expectStatus(runId, "succeeded");
      expect(forecast.started).toHaveLength(5);
      expect((await readRun(runId)).job("forecast")).toMatchObject({
        status: "degraded",
        error: "5th",
        output: { from: "fallback" },
      });
    });

    it("uses the fallback when the retry fails, however often workers died before", async () => {
      let fallbacks = 0;
      const ingest = scriptedStep("ingest", [hangs, hangs, hangs, hangs, permanent], {
        fallback: async () => (++fallbacks <= 4 ? hangs() : { from: "fallback" }),
      });
      const { runId } = await start();
      for (let nth = 1; nth <= 4; nth++) await startAndKill(ingest, nth);
      for (let nth = 1; nth <= 4; nth++) {
        const worker = startWorker([ingest.step], SHORT);
        await expect.poll(() => fallbacks, { timeout: 5_000 }).toBe(nth);
        workers.splice(workers.indexOf(worker), 1);
        await worker.stop(0);
      }
      startWorker([ingest.step], SHORT);
      await expectStatus(runId, "failed");
      await retry(runId, "ingest");
      await expectStatus(runId, "succeeded");
      expect((await readRun(runId)).job("ingest").status).toBe("degraded");
    });

    it("records the failure again when the retry fails", async () => {
      const analyze = scriptedStep("analyze", [...failsFourTimes, fails("5th")]);
      const { runId } = await start();
      startWorker([analyze.step]);
      await expectStatus(runId, "failed");
      await retry(runId, "analyze");
      await expect
        .poll(async () => (await readRun(runId)).run.error, { timeout: 5_000 })
        .toBe("analyze: 5th");
      const { run, job } = await readRun(runId);
      expect(run.status).toBe("failed");
      expect(job("analyze")).toMatchObject({ status: "failed", attempts: 1, error: "5th" });
    });
  });

  describe("a step that writes rows of its own", () => {
    const rowsOf = (runId: string) => db.select().from(forecasts).where(eq(forecasts.runId, runId));

    /** Saves one forecast row, as a step would; `then` runs after it in the same save. */
    function savesForecast(qty: number, then?: () => void) {
      return async ({ run, onSave }: StepContext) => {
        onSave(async (tx) => {
          await tx.delete(forecasts).where(eq(forecasts.runId, run.id));
          await tx.insert(forecasts).values({
            runId: run.id,
            outletId: run.outletId,
            itemId: ids.nasi,
            date: DATE,
            baselineQty: qty,
            model: "test",
          });
          then?.();
        });
        return { from: "run" };
      };
    }
    const midSave = () => {
      throw new Error("lost in the middle of saving");
    };

    it("leaves nothing of a save that failed, and one set of rows after the retry", async () => {
      let rowsBeforeRetry: unknown[] | undefined;
      const forecast = scriptedStep("forecast", [
        savesForecast(10, midSave),
        async (context) => {
          rowsBeforeRetry = await rowsOf(context.run.id);
          return savesForecast(20)(context);
        },
      ]);
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "succeeded");
      expect(rowsBeforeRetry).toEqual([]);
      expect((await rowsOf(runId)).map((row) => row.baselineQty)).toEqual([20]);
      expect((await readRun(runId)).job("forecast")).toMatchObject({
        attempts: 2,
        error: "lost in the middle of saving",
      });
    });

    it("leaves nothing when every save fails", async () => {
      const forecast = scriptedStep("forecast", [savesForecast(10, midSave)]);
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "failed");
      expect(await rowsOf(runId)).toEqual([]);
      expect((await readRun(runId)).job("forecast").output).toBeUndefined();
    });

    it("saves only the fallback's rows when it is degraded", async () => {
      const forecast = scriptedStep("forecast", [savesForecast(10, midSave)], {
        fallback: async (context) => {
          await savesForecast(30)(context);
          return { from: "fallback" };
        },
      });
      const { runId } = await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "succeeded");
      expect((await rowsOf(runId)).map((row) => row.baselineQty)).toEqual([30]);
    });

    it("drops the rows of a worker thought dead that finishes late", async () => {
      let finishLate = () => {};
      const late = new Promise<void>((resolve) => (finishLate = resolve));
      const forecast = scriptedStep("forecast", [
        async (context) => {
          await late;
          return savesForecast(10)(context);
        },
        savesForecast(20),
      ]);
      const { runId } = await start();
      startWorker([forecast.step]);
      await expect.poll(() => forecast.started.length).toBe(1);
      await workers.splice(0)[0]!.stop(0);
      await redis.clear();
      await start();
      startWorker([forecast.step]);
      await expectStatus(runId, "succeeded");
      finishLate();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await rowsOf(runId)).map((row) => row.baselineQty)).toEqual([20]);
    });
  });
});
