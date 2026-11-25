import type {
  AgentObservabilityOptions,
  AgentObserver,
  AgentTraceOptions,
} from "@anvia/core/observability";
import type { PipelineObserver, PipelineRunObservation } from "@anvia/core/pipeline";
import type { createLens } from "@sisaku/agents";
import { NIGHTLY_PIPELINE_AGENT } from "@sisaku/db";
import type { Attempt } from "./records";
import type { PipelineRun } from "./steps";
import { within } from "./within";

// One Anvia Lens trace per run, with a span per step attempt. Lens is best effort: nothing here
// throws, and an attempt waits for its span only as long as `START_WAIT_MS`. An agent waits for its
// own observer, which Lens serves without the network.

/** Anvia Lens in production; a recording fake in tests. */
export type PipelineLens = { pipeline: PipelineObserver; agent: AgentObserver };

type Log = (message: string, error?: unknown) => void;

/** The span of one attempt. Only the first of its endings counts. */
export type AttemptSpan = {
  /** For an agent the step runs, so that it is nested under this span. */
  readonly trace: AgentTraceOptions;
  readonly observability: AgentObservabilityOptions;
  end(): void;
  fail(error: unknown): void;
};

/** The span's id is needed before the step starts. A Lens client gives it without the network. */
const START_WAIT_MS = 200;
const DRAIN_WAIT_MS = 1_000;

/**
 * Lens as the pipeline uses it. "safe" keeps prompts, replies and tool bodies out (ADR 0012) but not
 * error messages, and a failed query's message has the values it would have saved. Those are cut off
 * here, for the steps and the agents they run; the job's record has the whole message.
 */
export function createPipelineLens(client: ReturnType<typeof createLens>): PipelineLens {
  const capture = {
    captureMode: "safe" as const,
    redactErrors: true,
    redaction: {
      patterns: [{ name: "failedQuery", regex: /Failed query:[^]*/g }],
      replacement: "Failed query (see the job)",
    },
  };
  return { pipeline: client.pipelineObserver(capture), agent: client.observer(capture) };
}

export function createPipelineTracer(lens: PipelineLens | undefined, log: Log) {
  const pending = new Set<Promise<void>>();
  const open = new Set<(error: Error) => void>();
  const logFailure = (error: unknown) => log("Lens failed", error);

  return {
    /** Starts the span of an attempt, in the trace whose id is on the run. */
    async start(run: PipelineRun, traceId: string, attempt: Attempt): Promise<AttemptSpan> {
      const startedAt = Date.now();
      const runLabels = {
        agent: NIGHTLY_PIPELINE_AGENT,
        run_id: run.id,
        outlet_id: run.outletId,
        business_date: run.businessDate,
      };
      const labels = { ...runLabels, step: attempt.step, attempt: attempt.number };
      const ids = { runId: run.id, pipelineId: NIGHTLY_PIPELINE_AGENT };

      const started: Promise<PipelineRunObservation | undefined> = (async () =>
        lens?.pipeline.startRun({
          ...ids,
          pipelineName: attempt.step,
          runMetadata: labels,
          trace: { name: NIGHTLY_PIPELINE_AGENT, traceId, metadata: runLabels },
          input: undefined,
        }))().catch((error: unknown) => {
        logFailure(error);
        return undefined;
      });

      let ended = false;
      /** Ends the span without waiting for it. */
      function finish(how: (span: PipelineRunObservation) => void | Promise<void>) {
        if (ended) return;
        ended = true;
        open.delete(cancel);
        const done = started
          .then((span) => span && how(span))
          .catch(logFailure)
          .finally(() => pending.delete(done));
        pending.add(done);
      }
      const durationMs = () => Date.now() - startedAt;
      const stop = (status: "failed" | "cancelled", error: unknown) =>
        finish((span) => span.error?.({ ...ids, status, error: error, durationMs: durationMs() }));
      const cancel = (error: Error) => stop("cancelled", error);
      open.add(cancel);

      const span = await within(START_WAIT_MS, started);
      const parentObservationId = span?.trace?.observationId;
      return {
        trace: {
          name: NIGHTLY_PIPELINE_AGENT,
          traceId,
          metadata: labels,
          ...(parentObservationId ? { parentObservationId } : {}),
        },
        observability: {
          ...(lens ? { observers: { lens: lens.agent }, primaryTrace: "lens" } : { observers: {} }),
          errorPolicy: "ignore",
          onObserverError: ({ error }) => logFailure(error),
        },
        end: () => finish((s) => s.end({ ...ids, output: undefined, durationMs: durationMs() })),
        fail: (error) => stop("failed", error),
      };
    },

    /** Ends the spans of steps left behind, and gives Lens a moment to take every ending. */
    async close(): Promise<void> {
      for (const cancel of open) cancel(new Error("The worker stopped"));
      await within(DRAIN_WAIT_MS, Promise.all(pending));
    },
  };
}
