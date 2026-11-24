import {
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
} from "@anvia/core";
import type { EvalReportArgs, EvalReporter } from "@anvia/core/evals";
import type { AgentObserver, AgentRunStartArgs } from "@anvia/core/observability";
import { COPILOT_INSTRUCTIONS_VERSION, copilotInstructionsFingerprint } from "@sisaku/agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import type { ToolCallCase } from "./cases";
import { formatMarkdown, formatText } from "./report";
import { prepareEvalEnvironment, runCopilotEval, type EvalEnvironment } from "./run-eval";

type Answer = { tool: string; input: JsonValue } | { text: string } | { hang: true };

/**
 * Answers by the user's message, so cases can run concurrently: the first request of a turn
 * gets the scripted answer, the request after a tool result gets a short text reply.
 */
class ByMessageModel implements CompletionModel {
  readonly provider = "stub";
  readonly modelId = "by-message";
  readonly capabilities = {
    streaming: false,
    tools: true,
    toolChoice: true,
    imageInput: true,
    documentInput: false,
    outputSchema: false,
    reasoning: false,
  };
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly answers: Record<string, Answer>) {}

  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(request));
    const base = { usage: Usage.empty(), rawResponse: {} };
    const last = request.chatHistory.at(-1);
    if (last?.role === "tool") {
      return { ...base, choice: [{ type: "text", text: "Selesai." }], finishReason: "stop" };
    }
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    const answer = Object.entries(this.answers).find(([message]) => text.includes(message))?.[1];
    if (!answer) throw new Error(`no scripted answer for ${text}`);
    if ("hang" in answer) return new Promise(() => undefined);
    if ("text" in answer) {
      return { ...base, choice: [{ type: "text", text: answer.text }], finishReason: "stop" };
    }
    return {
      ...base,
      choice: [
        {
          type: "tool-call",
          toolCallId: `call-${this.requests.length}`,
          toolName: answer.tool,
          input: answer.input,
        },
      ],
      finishReason: "tool-calls",
    };
  }
}

function toolCase(
  over: Partial<ToolCallCase> & Pick<ToolCallCase, "id" | "message" | "expected">,
): ToolCallCase {
  return { area: "waste_total", language: "id", role: "manager", today: "2026-04-01", ...over };
}

const yesterdayTotal = toolCase({
  id: "total-yesterday",
  message: "Berapa total limbah kemarin?",
  expected: {
    tool: "query_waste",
    args: { filters: { from: "2026-03-31", to: "2026-03-31" }, group_by: "none" },
  },
});

describe("Copilot eval database", () => {
  it("refuses a database whose name does not end in _test, before touching it", async () => {
    await expect(
      prepareEvalEnvironment("postgres://postgres:postgres@localhost:1/sisaku"),
    ).rejects.toThrow('"sisaku" does not end in _test');
  });
});

describe.skipIf(!testDbUrl)("Copilot eval run", () => {
  let env: EvalEnvironment;

  beforeAll(async () => {
    env = await prepareEvalEnvironment(testDbUrl!);
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  it("passes a case whose first tool call is the expected tool and arguments", async () => {
    const model = new ByMessageModel({
      "Berapa total limbah kemarin?": {
        tool: "query_waste",
        input: { filters: { from: "2026-03-31", to: "2026-03-31" }, group_by: "none" },
      },
    });
    const report = await runCopilotEval({
      env,
      model,
      datasets: [{ name: "tool-call", cases: [yesterdayTotal] }],
    });
    expect(report.suites).toMatchObject([{ name: "tool-call", passed: 1, total: 1 }]);
    expect(report.exitCode).toBe(0);
  });

  it("scores the first call by tool and argument subset, and reports each failure", async () => {
    const yesterday = { from: "2026-03-31", to: "2026-03-31" };
    const rendang = env.menu.get("Rendang Sapi")!;
    const cases = [
      toolCase({
        id: "extra-arg",
        area: "waste_total",
        message: "pesan extra",
        expected: { tool: "query_waste", args: { filters: yesterday } },
      }),
      toolCase({
        id: "placeholder",
        area: "sales",
        message: "pesan rendang",
        expected: { tool: "get_sales", args: { ...yesterday, item_id: "{item:Rendang Sapi}" } },
      }),
      toolCase({
        id: "no-tool",
        area: "no_tool",
        message: "pesan tolak",
        expected: { tool: null },
      }),
      toolCase({
        id: "wrong-tool",
        area: "waste_total",
        message: "pesan salah alat",
        expected: { tool: "query_waste", args: { filters: yesterday } },
      }),
      toolCase({
        id: "wrong-arg",
        area: "sales",
        message: "pesan salah tanggal",
        expected: { tool: "get_sales", args: yesterday },
      }),
      toolCase({
        id: "tool-when-none",
        area: "no_tool",
        message: "pesan harusnya tolak",
        expected: { tool: null },
      }),
    ];
    const model = new ByMessageModel({
      "pesan extra": {
        tool: "query_waste",
        input: { filters: yesterday, group_by: "item" },
      },
      "pesan rendang": { tool: "get_sales", input: { ...yesterday, item_id: rendang } },
      "pesan tolak": { text: "Maaf, saya hanya bisa melihat data outlet kamu." },
      "pesan salah alat": { tool: "get_sales", input: yesterday },
      "pesan salah tanggal": { tool: "get_sales", input: { from: "2026-03-30", to: "2026-03-30" } },
      "pesan harusnya tolak": { tool: "get_menu", input: {} },
    });

    const report = await runCopilotEval({ env, model, datasets: [{ name: "tool-call", cases }] });

    const [suite] = report.suites;
    expect(suite).toMatchObject({ passed: 3, total: 6 });
    expect(suite!.areas).toEqual({
      waste_total: { passed: 1, total: 2 },
      sales: { passed: 1, total: 2 },
      no_tool: { passed: 1, total: 2 },
    });
    expect(suite!.failures.map((f) => f.id).sort()).toEqual([
      "tool-when-none",
      "wrong-arg",
      "wrong-tool",
    ]);
    const wrongArg = suite!.failures.find((f) => f.id === "wrong-arg")!;
    expect(wrongArg.area).toBe("sales");
    expect(wrongArg.reason).toContain('"from":"2026-03-31"');
    expect(wrongArg.reason).toContain('"from":"2026-03-30"');
    expect(suite!.failures.find((f) => f.id === "tool-when-none")!.reason).toContain(
      "expected no tool call, got get_menu",
    );
    expect(report.exitCode).toBe(1);
    const text = formatText(report.suites);
    expect(text).toContain("tool-call: 3/6 (50%), bar 90% → FAIL");
    expect(text).toMatch(/sales\s+1\/2\s+50%/);
    expect(text).toContain("✗ wrong-arg [sales]: expected get_sales");
    expect(formatMarkdown(report.suites)).toContain(
      "| wrong-tool | waste_total | expected query_waste",
    );
  });

  it("runs each case as its role at the eval outlet, on its own day, after its history", async () => {
    const model = new ByMessageModel({
      "eh salah, harusnya 2 porsi": { text: "Oke." },
      "kemarin berapa": { text: "Oke." },
    });
    const cases = [
      toolCase({
        id: "owner-mid-march",
        role: "owner",
        today: "2026-03-15",
        message: "kemarin berapa",
        expected: { tool: null },
      }),
      toolCase({
        id: "staff-after-save",
        role: "staff",
        message: "eh salah, harusnya 2 porsi",
        history: [
          { role: "user", content: "rendang 3 porsi kebuang" },
          { role: "assistant", content: "Tersimpan ✓ entry_id: abc (Rendang Sapi)" },
        ],
        expected: { tool: null },
      }),
    ];

    const report = await runCopilotEval({ env, model, datasets: [{ name: "tool-call", cases }] });

    expect(report.suites[0]).toMatchObject({ passed: 2, total: 2 });
    const request = (message: string) =>
      model.requests.find((r) => JSON.stringify(r.chatHistory.at(-1)).includes(message))!;
    const owner = request("kemarin berapa");
    expect(owner.instructions).toContain("Current date: 2026-03-15 (Asia/Jakarta)");
    expect(owner.instructions).toContain("The user's role: owner.");
    expect(owner.instructions).toContain("Rendang Sapi"); // Warung Rina's menu
    const staff = request("eh salah");
    expect(staff.instructions).toContain("The user's role: staff.");
    expect(staff.chatHistory.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(staff.chatHistory[1])).toContain("entry_id: abc");
  });

  it("fails a case that runs past the time limit with reason timeout, and scores the rest", async () => {
    const model = new ByMessageModel({
      "pesan macet": { hang: true },
      "Berapa total limbah kemarin?": {
        tool: "query_waste",
        input: { filters: { from: "2026-03-31", to: "2026-03-31" }, group_by: "none" },
      },
    });
    const stuck = toolCase({ id: "stuck", message: "pesan macet", expected: { tool: null } });

    const report = await runCopilotEval({
      env,
      model,
      datasets: [{ name: "tool-call", cases: [stuck, yesterdayTotal] }],
      timeoutMs: 300,
    });

    expect(report.suites[0]).toMatchObject({
      passed: 1,
      total: 2,
      failures: [{ id: "stuck", reason: "timeout" }],
    });
  });

  it("runs only the selected cases, repeats them, and refuses an empty selection", async () => {
    const model = new ByMessageModel({
      "Berapa total limbah kemarin?": { tool: "get_menu", input: {} },
    });
    const other = toolCase({ id: "other", message: "tidak dijalankan", expected: { tool: null } });
    const datasets = [{ name: "tool-call" as const, cases: [yesterdayTotal, other] }];

    const report = await runCopilotEval({
      env,
      model,
      datasets,
      caseIds: ["total-yesterday"],
      repeat: 3,
    });

    expect(report.suites[0]).toMatchObject({ passed: 0, total: 3 });
    expect(report.suites[0]!.failures.map((f) => f.id)).toEqual([
      "total-yesterday#1",
      "total-yesterday#2",
      "total-yesterday#3",
    ]);
    await expect(
      runCopilotEval({ env, model, datasets, caseIds: ["no-such-case"] }),
    ).rejects.toThrow("No eval cases selected");
  });

  it("tags the JSON result with the instructions version, fingerprint, model, date and commit", async () => {
    const model = new ByMessageModel({
      "Berapa total limbah kemarin?": {
        tool: "get_sales",
        input: { from: "2026-03-31", to: "2026-03-31" },
      },
    });

    const report = await runCopilotEval({
      env,
      model,
      datasets: [{ name: "tool-call", cases: [yesterdayTotal] }],
      commit: "abc1234",
    });

    expect(report.json.run).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      commit: "abc1234",
      model: "by-message",
      instructions_version: COPILOT_INSTRUCTIONS_VERSION,
      instructions_fingerprint: copilotInstructionsFingerprint(),
    });
    expect(copilotInstructionsFingerprint()).toMatch(/^[0-9a-f]{16}$/);
    expect(report.json.suites).toMatchObject([
      {
        name: "tool-call",
        bar: 0.9,
        passed: 0,
        total: 1,
        cases: [
          {
            id: "total-yesterday",
            area: "waste_total",
            outcome: "fail",
            calls: [{ name: "get_sales", args: { from: "2026-03-31", to: "2026-03-31" } }],
            reply: "Selesai.",
          },
        ],
      },
    ]);
  });

  describe("with Lens", () => {
    /** Stands in for the Lens observer: keeps each run's start and gives it a trace id. */
    class FakeLensObserver implements AgentObserver {
      readonly starts: AgentRunStartArgs[] = [];
      constructor(private readonly failing = false) {}
      startRun(start: AgentRunStartArgs) {
        if (this.failing) throw new Error("Lens is down");
        this.starts.push(start);
        return { trace: { traceId: `trace-${this.starts.length}` }, end: () => undefined };
      }
    }

    /** Stands in for `lens.evalReporter()`: keeps every score it is given. */
    class RecordingReporter implements EvalReporter {
      readonly reports: EvalReportArgs<unknown, unknown, unknown, unknown>[] = [];
      report(args: EvalReportArgs<unknown, unknown, unknown, unknown>) {
        this.reports.push(args);
      }
    }

    const model = () =>
      new ByMessageModel({
        "Berapa total limbah kemarin?": {
          tool: "query_waste",
          input: { filters: { from: "2026-03-31", to: "2026-03-31" }, group_by: "none" },
        },
      });

    it("traces each case with eval metadata and reports its score with that trace", async () => {
      const observer = new FakeLensObserver();
      const reporter = new RecordingReporter();

      const report = await runCopilotEval({
        env,
        model: model(),
        datasets: [{ name: "tool-call", cases: [yesterdayTotal] }],
        lens: { observer, reporters: [reporter] },
      });

      expect(observer.starts).toHaveLength(1);
      expect(observer.starts[0]!.trace?.metadata).toMatchObject({
        eval_case: "total-yesterday",
        eval_dataset: "tool-call",
        instructions_version: COPILOT_INSTRUCTIONS_VERSION,
        model: "by-message",
      });
      expect(observer.starts[0]!.trace?.tags).toContain("eval");
      expect(reporter.reports).toMatchObject([
        {
          suiteName: "tool-call",
          case: { id: "total-yesterday" },
          trace: { traceId: "trace-1" },
          outcome: { outcome: "pass" },
        },
      ]);
      expect(report.json.suites[0]!.cases[0]!.trace_id).toBe("trace-1");
    });

    it("still scores every case when Lens fails, and notes the failure", async () => {
      const report = await runCopilotEval({
        env,
        model: model(),
        datasets: [{ name: "tool-call", cases: [yesterdayTotal] }],
        lens: { observer: new FakeLensObserver(true), reporters: [] },
      });

      expect(report.suites[0]).toMatchObject({ passed: 1, total: 1 });
      expect(report.suites[0]!.cases[0]!.errors.join()).toContain("Lens observer failed");
    });
  });
});
