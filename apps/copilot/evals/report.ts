import type { EvalSuiteResult } from "@anvia/core/evals";
import type { ToolCallCase } from "./cases";
import type { TurnOutput } from "./target";

export type Tally = { passed: number; total: number };

export type CaseFailure = { id: string; area: string; reason: string };

/** One case as the JSON result keeps it: what the Copilot did, for reading a failure later. */
export type CaseRecord = {
  id: string;
  area: string;
  outcome: "pass" | "fail" | "invalid";
  reason?: string;
  calls: TurnOutput["calls"];
  reply: string;
  errors: string[];
  trace_id?: string;
};

export type SuiteSummary = Tally & {
  areas: Record<string, Tally>;
  failures: CaseFailure[];
  cases: CaseRecord[];
};

/** A dataset's summary with the pass rate it must reach. */
export type SuiteReport = SuiteSummary & { name: string; bar: number };

/** Whether a dataset reached its bar. */
export const meetsBar = (s: SuiteReport) => s.passed / s.total >= s.bar;

const percent = (t: Tally) => `${((100 * t.passed) / t.total).toFixed(0)}%`;

/** The run's score as plain text, for the terminal: per dataset, per area, then each failure. */
export function formatText(suites: readonly SuiteReport[]): string {
  const lines: string[] = [];
  for (const s of suites) {
    const verdict = meetsBar(s) ? "PASS" : "FAIL";
    lines.push(
      `${s.name}: ${s.passed}/${s.total} (${percent(s)}), bar ${s.bar * 100}% → ${verdict}`,
    );
    for (const [area, t] of Object.entries(s.areas)) {
      lines.push(`  ${area.padEnd(16)} ${`${t.passed}/${t.total}`.padStart(5)}  ${percent(t)}`);
    }
    for (const f of s.failures) lines.push(`  ✗ ${f.id} [${f.area}]: ${f.reason}`);
  }
  return lines.join("\n");
}

/** Why a case did not pass: the metric's comment, or why it could not be scored. */
function failureReason(result: EvalSuiteResult<ToolCallCase, TurnOutput>["results"][number]) {
  for (const metric of result.metrics) {
    const { outcome } = metric;
    if (outcome.outcome === "invalid")
      return outcome.kind === "timeout" ? "timeout" : outcome.reason;
    if (outcome.outcome === "fail") return outcome.comment ?? "failed";
  }
  if (result.targetStatus === "failed") return `turn failed: ${String(result.targetError)}`;
  return "failed";
}

/** Passed and total per area, and every case that did not pass with its reason. */
export function summarizeSuite(result: EvalSuiteResult<ToolCallCase, TurnOutput>): SuiteSummary {
  const areas: Record<string, Tally> = {};
  const failures: CaseFailure[] = [];
  const cases: CaseRecord[] = [];
  let passed = 0;
  for (const r of result.results) {
    const area = r.case.input.area;
    const tally = (areas[area] ??= { passed: 0, total: 0 });
    tally.total++;
    const record: CaseRecord = {
      id: r.case.id,
      area,
      outcome: r.outcome,
      calls: r.output?.calls ?? [],
      reply: r.output?.reply ?? "",
      errors: r.output?.errors ?? [],
      ...(r.output?.trace ? { trace_id: r.output.trace.traceId } : {}),
    };
    if (r.outcome === "pass") {
      tally.passed++;
      passed++;
    } else {
      record.reason = failureReason(r);
      failures.push({ id: r.case.id, area, reason: record.reason });
    }
    cases.push(record);
  }
  return { passed, total: result.results.length, areas, failures, cases };
}
