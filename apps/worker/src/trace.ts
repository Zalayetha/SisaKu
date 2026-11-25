import type {
  AgentObservabilityOptions,
  AgentObserver,
  AgentTraceOptions,
} from "@anvia/core/observability";
import type { PipelineObserver, PipelineRunObservation } from "@anvia/core/pipeline";
import { NIGHTLY_PIPELINE_AGENT } from "@sisaku/db";
import type { Attempt } from "./records";
import type { PipelineRun } from "./steps";

// One Anvia Lens trace per run, with a span per step attempt. Lens is best effort: nothing here
// throws, and a step waits for it only as long as `START_WAIT_MS`.

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

function within<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeUp = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, ms, undefined)));
  return Promise.race([promise, timeUp]).finally(() => clearTimeout(timer));
}

/**
 * The error without what a failed query would have saved, which is business data: `safe` capture
 * keeps error messages. The job's record has the whole message.
 */
function safeError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = original.message.replace(/Failed query:[^]*$/, "Failed query (see the job)");
  const safe = new Error(message);
  safe.name = original.name;
  const frames = original.stack?.split("\n").filter((line) => /^\s+at /.test(line)) ?? [];
  safe.stack = [`${safe.name}: ${message}`, ...frames].join("\n");
  return safe;
}

export function createPipelineTracer(lens: PipelineLens | undefined, log: Log) {
  const pending = new Set<Promise<void>>();
  const open = new Set<(error: Error) => void>();
  const failed = (error: unknown) => log("Lens failed", error);

  return {
    /** Starts the span of an attempt, in the trace whose id is on the run. */
    async start(run: PipelineRun, traceId: string, attempt: Attempt): Promise<AttemptSpan> {
      const startedAt = Date.now();
      const ofRun = {
        agent: NIGHTLY_PIPELINE_AGENT,
        run_id: run.id,
        outlet_id: run.outletId,
        business_date: run.businessDate,
      };
      const labels = { ...ofRun, step: attempt.step, attempt: attempt.number };
      const ids = { runId: run.id, pipelineId: NIGHTLY_PIPELINE_AGENT };

      const started: Promise<PipelineRunObservation | undefined> = (async () =>
        lens?.pipeline.startRun({
          ...ids,
          pipelineName: attempt.step,
          runMetadata: labels,
          trace: { name: NIGHTLY_PIPELINE_AGENT, traceId, metadata: ofRun },
          input: undefined,
        }))().catch((error: unknown) => {
        failed(error);
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
          .catch(failed)
          .finally(() => pending.delete(done));
        pending.add(done);
      }
      const durationMs = () => Date.now() - startedAt;
      const stop = (status: "failed" | "cancelled", error: unknown) =>
        finish((span) =>
          span.error?.({ ...ids, status, error: safeError(error), durationMs: durationMs() }),
        );
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
          onObserverError: ({ error }) => failed(error),
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
