import {
  Agent,
  createTool,
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
} from "@anvia/core";
import type { AgentObserver, AgentRunStartArgs } from "@anvia/core/observability";
import type { McpClientGroup } from "@anvia/mcp";
import type {
  PipelineObserver,
  PipelineRunErrorArgs,
  PipelineRunStartArgs,
} from "@anvia/core/pipeline";
import { createLens } from "@sisaku/agents";
import { connectInMemoryServers } from "@sisaku/agents/testing";
import { PIPELINE_STEPS } from "@sisaku/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import {
  createPipelineLens,
  createPipelineRuns,
  createPipelineWorker,
  DEFAULT_STEPS,
  type PipelineWorkerDeps,
  type StepContext,
  type StepDefinition,
} from "./index";
import { startLensServer } from "./testing/lens-server";
import { testRedis, testRedisUrl } from "./testing/redis";
import {
  deleteRuns,
  expectStatus as expectRunStatus,
  readRun as readRunFrom,
} from "./testing/runs";

const DATE = "2026-03-01";

type RecordedSpan = {
  start: PipelineRunStartArgs;
  id: string;
  outcome?: "ended" | PipelineRunErrorArgs["status"];
  error?: unknown;
  output?: unknown;
};

/** Stands in for Anvia Lens: records a span per step attempt, and the agent runs inside them. */
function recordingLens() {
  const spans: RecordedSpan[] = [];
  const agentRuns: AgentRunStartArgs[] = [];
  const pipeline: PipelineObserver = {
    startRun(start) {
      const span: RecordedSpan = { start, id: `span-${spans.length + 1}` };
      spans.push(span);
      return {
        trace: { traceId: start.trace?.traceId, observationId: span.id },
        end: ({ output }) => {
          span.outcome = "ended";
          span.output = output;
        },
        error: ({ status, error }) => {
          span.outcome = status;
          span.error = error;
        },
      };
    },
  };
  const agent: AgentObserver = {
    startRun(start) {
      agentRuns.push(start);
      return { end: () => undefined };
    },
  };
  return { spans, agentRuns, lens: { pipeline, agent } };
}

function step(
  name: StepDefinition["name"],
  run: (context: StepContext) => Promise<unknown>,
  extra: Partial<StepDefinition> = {},
): StepDefinition {
  return { name, output: z.object({ ok: z.literal(true) }), run, ...extra };
}

/** Answers every request with the same text. */
const fakeModel: CompletionModel = {
  provider: "stub",
  modelId: "fake",
  capabilities: {
    streaming: false,
    tools: false,
    toolChoice: false,
    imageInput: false,
    documentInput: false,
    outputSchema: false,
    reasoning: false,
  },
  completion: async (_request: CompletionRequest): Promise<CompletionResponse> => ({
    usage: Usage.empty(),
    rawResponse: {},
    choice: [{ type: "text", text: "nothing unusual" }],
    finishReason: "stop",
  }),
};

const ok = async () => ({ ok: true });

describe.skipIf(!testDbUrl || !testRedisUrl)("pipeline traces", { timeout: 15_000 }, () => {
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
    runs = createPipelineRuns({ db, redis: redis.redis, retryDelayMs: 50 });
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop(500)));
    await redis.clear();
    await deleteRuns(db);
  });
  afterAll(async () => {
    await runs?.close();
    await redis?.close();
    await mcp?.close();
    await pool?.end();
  });

  const start = () => runs.startManual({ outlet: ids.outletA, date: DATE });
  const readRun = (runId: string) => readRunFrom(db, runId);
  const expectStatus = (runId: string, status: "succeeded" | "failed") =>
    expectRunStatus(db, runId, status);

  function startWorker(
    lens: PipelineWorkerDeps["lens"],
    steps: StepDefinition[] = [],
    extra: Partial<PipelineWorkerDeps> = {},
  ) {
    const worker = createPipelineWorker({
      db,
      servers: mcp.servers,
      redis: redis.redis,
      steps: { ...DEFAULT_STEPS, ...Object.fromEntries(steps.map((s) => [s.name, s])) },
      log: () => undefined,
      ...(lens ? { lens } : {}),
      ...extra,
    });
    workers.push(worker);
    return worker;
  }

  it("gives every step a labelled span in the run's trace, with no names and no content", async () => {
    const { spans, lens } = recordingLens();
    const { runId } = await start();
    startWorker(lens);
    await expectStatus(runId, "succeeded");

    const { run } = await readRun(runId);
    expect(spans.map((span) => span.start.trace?.traceId)).toEqual(Array(5).fill(run.traceId));
    expect(spans.map((span) => span.start.runMetadata)).toEqual(
      PIPELINE_STEPS.map((name) => ({
        agent: "nightly-pipeline",
        run_id: runId,
        outlet_id: ids.outletA,
        business_date: DATE,
        step: name,
        attempt: 1,
      })),
    );
    await expect.poll(() => spans.map((span) => span.outcome)).toEqual(Array(5).fill("ended"));
    // Ingest's output has the day's numbers and item names.
    expect(spans.map((span) => [span.start.input, span.output])).toEqual(
      Array(5).fill([undefined, undefined]),
    );
    expect(JSON.stringify(spans)).not.toMatch(/Warung|Rendang|Nasi/);
    expect(run.costUsd).toBeNull();
  });

  it("gives every attempt its own span in the same trace, also after a worker restart", async () => {
    const first = recordingLens();
    const second = recordingLens();
    let starts = 0;
    let finishLate = () => {};
    const analyze = step("analyze", async () => {
      if (++starts === 1) throw new Error("model overloaded");
      if (starts === 2) await new Promise<void>((resolve) => (finishLate = resolve));
      return { ok: true };
    });
    const { runId } = await start();
    const worker = startWorker(first.lens, [analyze], { stalledAfterMs: 200 });
    await expect.poll(() => starts, { timeout: 5_000 }).toBe(2);
    workers.splice(workers.indexOf(worker), 1);
    await worker.stop(0);
    startWorker(second.lens, [analyze], { stalledAfterMs: 200 });
    await expectStatus(runId, "succeeded");
    // The step left behind ends at last, which changes nothing.
    finishLate();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const { run } = await readRun(runId);
    const spans = [...first.spans, ...second.spans];
    expect(new Set(spans.map((span) => span.start.trace?.traceId))).toEqual(new Set([run.traceId]));
    const analyzed = spans.filter((span) => span.start.runMetadata?.step === "analyze");
    expect(analyzed.map((span) => span.start.runMetadata?.attempt)).toEqual([1, 2, 3]);
    await expect
      .poll(() => analyzed.map((span) => span.outcome))
      .toEqual(["failed", "cancelled", "ended"]);
    expect(analyzed[0]!.error).toMatchObject({ message: "model overloaded" });
    expect(analyzed[1]!.error).toMatchObject({ message: "The worker stopped" });
  });

  it("keeps the error that degraded a step, and adds the fallback's if it fails too", async () => {
    const { spans, lens } = recordingLens();
    let fallbacks = 0;
    const failing = async () => {
      throw new Error("no model");
    };
    const forecast = step("forecast", failing, {
      fallback: async () => {
        fallbacks++;
        return { ok: true };
      },
    });
    const recommend = step("recommend", failing, {
      fallback: async () => {
        throw new Error("no baseline");
      },
    });
    const { runId } = await start();
    startWorker(lens, [forecast, recommend]);
    await expectStatus(runId, "failed");
    expect(fallbacks).toBe(1);
    const errorsOf = (name: string) =>
      spans
        .filter((span) => span.start.runMetadata?.step === name)
        .map((span) => (span.error as Error | undefined)?.message);
    await expect.poll(() => errorsOf("recommend").filter(Boolean)).toHaveLength(4);
    expect(errorsOf("forecast")).toEqual(Array(4).fill("no model"));
    expect(errorsOf("recommend")).toEqual([
      ...Array(3).fill("no model"),
      "no model; its fallback failed: no baseline",
    ]);
  });

  it("nests an agent a step runs under that attempt's span", async () => {
    const { spans, agentRuns, lens } = recordingLens();
    let attempt = 0;
    const analyze = step("analyze", async ({ trace, observability }) => {
      const agent = new Agent({ id: "analyst", model: fakeModel, observability });
      await agent.generate({ messages: [{ role: "user", content: "go" }], trace });
      if (++attempt === 1) throw new Error("again");
      return { ok: true };
    });
    const { runId } = await start();
    startWorker(lens, [analyze]);
    await expectStatus(runId, "succeeded");

    const { run } = await readRun(runId);
    const analyzed = spans.filter((span) => span.start.runMetadata?.step === "analyze");
    expect(analyzed).toHaveLength(2);
    expect(agentRuns.map(({ trace }) => [trace?.traceId, trace?.parentObservationId])).toEqual(
      analyzed.map((span) => [run.traceId, span.id]),
    );
    // The agent's own labels say which run it belongs to as well.
    expect(agentRuns[0]!.trace?.metadata).toMatchObject({
      agent: "nightly-pipeline",
      run_id: runId,
      outlet_id: ids.outletA,
      business_date: DATE,
      step: "analyze",
      attempt: 1,
    });
  });

  it.each([
    [
      "throws",
      {
        startRun: () => {
          throw new Error("Lens is down");
        },
      },
    ],
    ["rejects", { startRun: () => Promise.reject(new Error("Lens is down")) }],
    ["never answers", { startRun: () => new Promise<never>(() => {}) }],
    [
      "fails to end a span",
      {
        startRun: () => ({
          end: () => Promise.reject(new Error("Lens is down")),
          error: () => {
            throw new Error("Lens is down");
          },
        }),
      },
    ],
    [
      "never ends a span",
      {
        startRun: () => ({
          end: () => new Promise<never>(() => {}),
          error: () => new Promise<never>(() => {}),
        }),
      },
    ],
  ] satisfies [string, PipelineObserver][])("runs on when Lens %s", async (_how, pipeline) => {
    let starts = 0;
    const analyze = step("analyze", async () => {
      if (++starts === 1) throw new Error("once");
      return { ok: true };
    });
    const { runId } = await start();
    const before = Date.now();
    const worker = startWorker({ pipeline, agent: recordingLens().lens.agent }, [analyze]);
    await expectStatus(runId, "succeeded");
    expect(Date.now() - before).toBeLessThan(4_000);
    expect((await readRun(runId)).job("analyze")).toMatchObject({ attempts: 2, error: "once" });
    const stopping = Date.now();
    await worker.stop();
    expect(Date.now() - stopping).toBeLessThan(2_000);
  });

  it("sends the real Lens no prompt, reply, tool content or saved values, agents included", async () => {
    const server = await startLensServer();
    const client = createLens("sisaku-pipeline", server.env);
    const secret = "Rendang Sapi";
    const failingQuery = () => db.execute(sql`insert into missing values (${secret})`);
    const lookUp = createTool({
      name: "look_up",
      description: "Looks up an item.",
      inputSchema: z.object({ item: z.string() }),
      handler: async () => {
        await failingQuery();
        return "never";
      },
    });
    let requests = 0;
    const model: CompletionModel = {
      ...fakeModel,
      capabilities: { ...fakeModel.capabilities, tools: true },
      completion: async (): Promise<CompletionResponse> => ({
        usage: Usage.empty(),
        rawResponse: {},
        ...(++requests % 2 === 1
          ? {
              choice: [
                {
                  type: "tool-call",
                  toolCallId: `call-${requests}`,
                  toolName: "look_up",
                  input: { item: secret },
                },
              ],
              finishReason: "tool-calls",
            }
          : { choice: [{ type: "text", text: secret }], finishReason: "stop" }),
      }),
    };
    const analyze = step("analyze", async ({ trace, observability, onSave }) => {
      const agent = new Agent({ id: "analyst", model, tools: [lookUp], observability });
      await agent.generate({ messages: [{ role: "user", content: secret }], trace });
      onSave(async (tx) => {
        await tx.execute(sql`insert into missing values (${secret})`);
      });
      return { ok: true };
    });
    try {
      const { runId } = await start();
      startWorker(createPipelineLens(client), [analyze]);
      await expectStatus(runId, "failed");
      await workers.splice(0)[0]!.stop();
      await client.close();

      const { run, job } = await readRun(runId);
      expect(job("analyze").error).toContain(secret);
      const spans = server.spans();
      expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([run.traceId]));
      const attempts = spans.filter((span) => span.name === "pipeline.analyze");
      expect(attempts).toHaveLength(4);
      const tools = spans.filter((span) => span.name === "tool.look_up");
      expect(tools).toHaveLength(4);
      const agents = spans.filter((span) => span.name.startsWith("agent"));
      expect(agents.map((span) => span.parentSpanId).sort()).toEqual(
        attempts.map((span) => span.spanId).sort(),
      );
      expect(server.raw()).toContain("Failed query (see the job)");
      expect(server.raw()).not.toContain("Rendang");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not mark the attempt of a worker thought dead as completed", async () => {
    const first = recordingLens();
    const second = recordingLens();
    let starts = 0;
    let finishLate = () => {};
    const analyze = step("analyze", async () => {
      if (++starts === 1) await new Promise<void>((resolve) => (finishLate = resolve));
      return { ok: true };
    });
    const { runId } = await start();
    // The first worker keeps its step but loses the job, as after a long pause.
    startWorker(first.lens, [analyze]);
    await expect.poll(() => starts).toBe(1);
    await redis.clear();
    await start();
    startWorker(second.lens, [analyze]);
    await expectStatus(runId, "succeeded");
    finishLate();
    const late = first.spans.find((span) => span.start.runMetadata?.step === "analyze")!;
    await expect.poll(() => late.outcome).toBe("failed");
    expect((late.error as Error).message).toMatch(/Attempt 1 of analyze .* is not current/);
  });

  it("runs on when Lens fails inside an agent a step runs", async () => {
    const agent: AgentObserver = {
      startRun: () => {
        throw new Error("Lens is down");
      },
    };
    const analyze = step("analyze", async ({ trace, observability }) => {
      const analyst = new Agent({ id: "analyst", model: fakeModel, observability });
      await analyst.generate({ messages: [{ role: "user", content: "go" }], trace });
      return { ok: true };
    });
    const { runId } = await start();
    startWorker({ ...recordingLens().lens, agent }, [analyze]);
    await expectStatus(runId, "succeeded");
    expect((await readRun(runId)).job("analyze").attempts).toBe(1);
  });

  it("works without Lens", async () => {
    const { runId } = await start();
    startWorker(undefined, [step("analyze", ok)]);
    await expectStatus(runId, "succeeded");
  });
});
