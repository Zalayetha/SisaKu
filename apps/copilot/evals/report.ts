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

type NamedSuite = SuiteSummary & { name: string; bar: number };

const percent = (t: Tally) => `${((100 * t.passed) / t.total).toFixed(0)}%`;

/** The run's score as plain text, for the terminal: per dataset, per area, then each failure. */
export function formatText(suites: readonly NamedSuite[]): string {
  const lines: string[] = [];
  for (const s of suites) {
    const verdict = s.passed / s.total >= s.bar ? "PASS" : "FAIL";
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

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The same as Markdown, for the GitHub Actions job summary. */
export function formatMarkdown(suites: readonly NamedSuite[]): string {
  const lines: string[] = ["## Copilot eval", ""];
  for (const s of suites) {
    const verdict = s.passed / s.total >= s.bar ? "✅" : "❌";
    lines.push(
      `### ${s.name}: ${s.passed}/${s.total} (${percent(s)}) ${verdict} bar ${s.bar * 100}%`,
      "",
    );
    lines.push("| Area | Passed | % |", "| --- | --- | --- |");
    for (const [area, t] of Object.entries(s.areas)) {
      lines.push(`| ${area} | ${t.passed}/${t.total} | ${percent(t)} |`);
    }
    if (s.failures.length > 0) {
      lines.push("", "| Failed case | Area | Why |", "| --- | --- | --- |");
      for (const f of s.failures) lines.push(`| ${f.id} | ${f.area} | ${cell(f.reason)} |`);
    }
    lines.push("");
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
