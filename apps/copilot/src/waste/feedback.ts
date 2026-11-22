import type { AnyTool, JsonValue, ToolCallContext } from "@anvia/core";
import { parseToolJson } from "@sisaku/agents";
import { agentRuns } from "@sisaku/db";
import { eq } from "drizzle-orm";
import type { Db } from "../users";

/** Attaches a named score to a Lens trace. Field names only, never values (ADR 0012, 0014). */
export type FeedbackScorer = {
  score(args: {
    traceId: string;
    name: string;
    value: number;
    metadata?: Record<string, JsonValue>;
  }): void | Promise<void>;
};

export type Log = (message: string, error?: unknown) => void;

/** Sends a score, never failing the caller: Lens is best-effort. */
export async function sendScore(
  scorer: FeedbackScorer,
  log: Log,
  args: Parameters<FeedbackScorer["score"]>[0],
): Promise<void> {
  try {
    await scorer.score(args);
  } catch (error) {
    log("Lens score failed", error);
  }
}

type Entry = {
  item_id: string;
  cause: string;
  logged_at: string;
  portion_count: number | null;
  weight_kg: number;
  run_id: string | null;
};

const FIELDS = ["item_id", "cause", "logged_at", "portion_count", "weight_kg"] as const;

/**
 * Wraps the scoped `update_entry` tool: after a correction, scores `waste_entry_corrected` on the
 * trace of the turn that logged the entry. Entries from CSV or mock data have no run and no score.
 */
export function withCorrectionFeedback(
  tool: AnyTool,
  deps: { db: Db; scorer: FeedbackScorer; userId: string; log: Log },
): AnyTool {
  return {
    name: tool.name,
    definition: (prompt: string) => tool.definition(prompt),
    parseInput: (args: JsonValue) => (tool.parseInput ? tool.parseInput(args) : args),
    async call(args: unknown, context?: ToolCallContext) {
      const result = await tool.call(args, context);
      try {
        const { before, after } = parseToolJson<{ before: Entry; after: Entry }>(result);
        if (before.run_id) {
          const [run] = await deps.db
            .select({ traceId: agentRuns.traceId })
            .from(agentRuns)
            .where(eq(agentRuns.id, before.run_id));
          if (run?.traceId) {
            const fields = FIELDS.filter((f) => before[f] !== after[f]).map((f) =>
              f === "item_id" ? "item" : f,
            );
            await sendScore(deps.scorer, deps.log, {
              traceId: run.traceId,
              name: "waste_entry_corrected",
              value: 1,
              metadata: { fields, user_id: deps.userId },
            });
          }
        }
      } catch (error) {
        deps.log("Recording a correction failed", error);
      }
      return result;
    },
  };
}
