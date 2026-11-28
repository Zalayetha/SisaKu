import type { CompletionModel } from "@anvia/core";
import type { AgentObservabilityOptions, AgentTraceOptions } from "@anvia/core/observability";
import type { McpServer } from "@anvia/core/mcp";
import type { PipelineStep } from "@sisaku/db";
import * as z from "zod";
import { createAnalyzeStep } from "./analyze";
import { ingestStep } from "./ingest";
import type { Tx } from "./runs";

/** Thrown by a step when trying again cannot help, so it gets no other attempt. */
export class PermanentError extends Error {}

/** The pipeline run a step works for. */
export type PipelineRun = {
  readonly id: string;
  readonly outletId: string;
  /** The outlet's IANA time zone. */
  readonly timezone: string;
  /** The outlet-local day the run covers (YYYY-MM-DD). The run forecasts the day after. */
  readonly businessDate: string;
};

export type StepContext = {
  readonly run: PipelineRun;
  /** The outputs of the steps before this one, validated against their schemas. */
  readonly outputs: Readonly<Partial<Record<PipelineStep, unknown>>>;
  readonly servers: readonly McpServer[];
  /** Passed to any agent the step runs, with `observability`: nests it in the run's Lens trace. */
  readonly trace: AgentTraceOptions;
  readonly observability: AgentObservabilityOptions;
  /** Aborted when the step's time limit is up. */
  readonly signal: AbortSignal;
  /**
   * Adds writes of the step's own rows to the transaction that saves its result, so they are saved
   * together or not at all. Delete this run's rows first, then insert: a rerun replaces them. Rows
   * written any other way are left behind by a failed attempt.
   */
  onSave(write: (tx: Tx) => Promise<void>): void;
};

/** One step of the nightly pipeline. Replacing a stub means replacing one of these. */
export type StepDefinition<Output = unknown> = {
  readonly name: PipelineStep;
  /** Output that does not match, or does not after being stored as JSON, is never saved. */
  readonly output: z.ZodType<Output>;
  run(context: StepContext): Promise<Output>;
  /** What to save instead once the step's attempts have run out. Also has the time limit. */
  fallback?(context: StepContext, error: unknown): Promise<Output>;
  /** For one attempt; `DEFAULT_TIME_LIMIT_MS` when left out. */
  readonly timeLimitMs?: number;
};

export const DEFAULT_TIME_LIMIT_MS = 5 * 60 * 1000;

export type PipelineSteps = { readonly [Step in PipelineStep]: StepDefinition };

const stubOutput = z.object({ stub: z.literal(true) });

/** Holds a step's place until its own issue builds it. Writes no domain rows. */
function stubStep(name: PipelineStep): StepDefinition<z.infer<typeof stubOutput>> {
  return { name, output: stubOutput, run: async () => ({ stub: true }) };
}

/** What the pipeline's own steps are built with. */
export type StepDeps = {
  /** The model every agent a step runs uses (technical design: one model for every agent). */
  readonly model: CompletionModel;
};

/** The nightly pipeline's steps. */
export function defaultSteps({ model }: StepDeps): PipelineSteps {
  return {
    ingest: ingestStep,
    analyze: createAnalyzeStep({ model }),
    forecast: stubStep("forecast"),
    recommend: stubStep("recommend"),
    report: stubStep("report"),
  };
}
