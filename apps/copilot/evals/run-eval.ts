import type { CompletionModel } from "@anvia/core";
import { runEvalCli, type EvalReporter } from "@anvia/core/evals";
import type { AgentObserver } from "@anvia/core/observability";
import { COPILOT_INSTRUCTIONS_VERSION, copilotInstructionsFingerprint } from "@sisaku/agents";
import type { CopilotInput, ExpectedCall, ToolCallCase } from "./cases";
import type { EvalEnvironment } from "./environment";
import { toolCallMetric } from "./metrics";
import { meetsBar, summarizeSuite, type SuiteReport } from "./report";
import { createCopilotTarget, turnOutput, type TurnOutput } from "./target";

export { prepareEvalEnvironment, type EvalEnvironment } from "./environment";

export type DatasetName = "tool-call";

/** The pass rate each dataset must reach (technical design). */
export const BARS: Record<DatasetName, number> = { "tool-call": 0.9 };

export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_CONCURRENCY = 4;
/** Longest value printed per case; the JSON result keeps everything. */
const PRINT_MAX_LENGTH = 300;

/** What a run measured, against which instructions and model; written as the JSON result. */
export type EvalResultJson = {
  run: {
    date: string;
    commit?: string;
    model: string;
    instructions_version: string;
    instructions_fingerprint: string;
  };
  suites: SuiteReport[];
};

export type EvalReport = {
  suites: SuiteReport[];
  exitCode: 0 | 1;
  json: EvalResultJson;
  /** Things to tell the user that do not change a score, such as Lens failing. */
  warnings: string[];
};

export type RunOptions = {
  env: EvalEnvironment;
  model: CompletionModel;
  datasets: { name: DatasetName; cases: readonly ToolCallCase[] }[];
  /** Per case; a case that runs longer fails with reason "timeout". */
  timeoutMs?: number;
  /** Cases run at the same time. */
  concurrency?: number;
  /** Only these case ids; a dataset with none of them is skipped. */
  caseIds?: readonly string[];
  /** Runs every case this many times, as `<id>#1`, `<id>#2`, … */
  repeat?: number;
  /** The commit under test, recorded in the result. */
  commit?: string;
  /** Receives every case's outcome as text, for the terminal; nothing is printed without it. */
  print?: (text: string) => void;
  /** Lens, when configured: traces every case and receives every score with its trace. */
  lens?: {
    observer: AgentObserver;
    reporters: readonly EvalReporter<CopilotInput, TurnOutput, ExpectedCall>[];
  };
};

/** The selected cases of a dataset, each repeated; ids get `#n` when repeated. */
function selectCases(cases: readonly ToolCallCase[], options: RunOptions) {
  const repeat = options.repeat ?? 1;
  const chosen = options.caseIds ? cases.filter((c) => options.caseIds!.includes(c.id)) : cases;
  return chosen.flatMap((c) =>
    Array.from({ length: repeat }, (_, i) => ({
      ...c,
      id: repeat > 1 ? `${c.id}#${i + 1}` : c.id,
    })),
  );
}

/** Runs the selected cases of each dataset through the Copilot and scores them. */
export async function runCopilotEval(options: RunOptions): Promise<EvalReport> {
  const date = new Date().toISOString();
  const selected = options.datasets
    .map((dataset) => ({ name: dataset.name, cases: selectCases(dataset.cases, options) }))
    .filter((dataset) => dataset.cases.length > 0);
  if (selected.length === 0) throw new Error("No eval cases selected");

  const suites: SuiteReport[] = [];
  const warnings: string[] = [];
  for (const dataset of selected) {
    // `exitCode` stays unset: Anvia's exit code fails on any failed case, ours follows the bar.
    const result = await runEvalCli({
      name: dataset.name,
      cases: dataset.cases,
      target: createCopilotTarget({
        env: options.env,
        model: options.model,
        dataset: dataset.name,
        observer: options.lens?.observer,
      }),
      metrics: [toolCallMetric],
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      caseTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      trace: (result) => turnOutput(result)?.trace,
      reporters: options.lens?.reporters ?? [],
      reporterErrorPolicy: "collect",
      format: options.print ? "pretty" : "quiet",
      maxValueLength: PRINT_MAX_LENGTH,
      ...(options.print ? { output: { stdout: options.print } } : {}),
    });
    const suite = { name: dataset.name, bar: BARS[dataset.name], ...summarizeSuite(result) };
    suites.push(suite);
    const untraced = suite.cases.filter((c) =>
      c.errors.some((e) => e.startsWith("Lens observer failed")),
    ).length;
    if (untraced > 0) {
      warnings.push(
        `${dataset.name}: Lens could not trace ${untraced} case(s); their scores are unaffected`,
      );
    }
    if (result.reporterErrors.length > 0) {
      warnings.push(
        `${dataset.name}: Lens did not receive ${result.reporterErrors.length} score(s)`,
      );
    }
  }
  const failed = !suites.every(meetsBar);
  return {
    suites,
    exitCode: failed ? 1 : 0,
    warnings,
    json: {
      run: {
        date,
        ...(options.commit ? { commit: options.commit } : {}),
        model: options.model.modelId,
        instructions_version: COPILOT_INSTRUCTIONS_VERSION,
        instructions_fingerprint: copilotInstructionsFingerprint(),
      },
      suites,
    },
  };
}
