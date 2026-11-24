import type { ChannelEvent } from "@anvia/channel";
import type { CompletionModel, JsonObject } from "@anvia/core";
import type { AgentObserver, AgentRunObserver } from "@anvia/core/observability";
import { COPILOT_INSTRUCTIONS_VERSION } from "@sisaku/agents";
import { ChatHistory } from "../src/history";
import { FakePhotoStore, RecordingRenderer, RecordingScorer } from "../src/testing/harness";
import { APOLOGY, createTurnHandler } from "../src/turn";
import { createUserLookup } from "../src/users";
import type { ToolCallCase } from "./cases";
import type { EvalEnvironment } from "./environment";

export type ToolCall = { name: string; args: unknown };

/** What one case's turn did: every tool call in order, the reply, and its trace when traced. */
export type TurnOutput = {
  calls: ToolCall[];
  reply: string;
  errors: string[];
  trace?: { traceId: string };
};

function parseToolArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Records every tool call of a run into `output`, and forwards the run to `inner` (Lens) when
 * given, with the eval's metadata and an "eval" tag added to the trace. A failing inner
 * observer is dropped for that run, so Lens never decides a score.
 */
function recordingObserver(
  output: TurnOutput,
  inner: AgentObserver | undefined,
  metadata: JsonObject,
): AgentObserver {
  return {
    async startRun(args) {
      let run: AgentRunObserver | undefined;
      try {
        const trace = {
          ...args.trace,
          metadata: { ...args.trace?.metadata, ...metadata },
          tags: [...(args.trace?.tags ?? []), "eval"],
        };
        run = inner ? await inner.startRun({ ...args, trace }) : undefined;
      } catch (error) {
        output.errors.push(`Lens observer failed: ${String(error)}`);
      }
      if (run?.trace?.traceId) output.trace = { traceId: run.trace.traceId };
      const observer: AgentRunObserver = {
        ...(run?.trace ? { trace: run.trace } : {}),
        startGeneration: (generation) => run?.startGeneration?.(generation),
        startTool: (tool) => {
          output.calls.push({ name: tool.toolName, args: parseToolArgs(tool.args) });
          return run?.startTool?.(tool);
        },
        end: (end) => run?.end(end),
        error: (error) => run?.error?.(error),
        event: (event) => run?.event?.(event),
      };
      return observer;
    },
  };
}

/** Noon on `day` in `timezone`, as an instant. */
export function noonIn(day: string, timezone: string): Date {
  const guess = new Date(`${day}T12:00:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()));
}

export type TargetDeps = {
  env: EvalEnvironment;
  model: CompletionModel;
  /** The dataset the cases come from, recorded on each trace. */
  dataset: string;
  /** Lens, when configured. */
  observer?: AgentObserver | undefined;
};

/**
 * Runs one case through the real Copilot turn handler: the case's role at the eval outlet, its
 * history as earlier chat, and the clock pinned to noon on its `today`.
 */
export function createCopilotTarget(deps: TargetDeps) {
  const { env } = deps;
  return async (input: ToolCallCase, testCase: { id: string }): Promise<TurnOutput> => {
    const output: TurnOutput = { calls: [], reply: "", errors: [] };
    const chatId = `eval-${testCase.id}`;
    const history = new ChatHistory(20);
    const earlier = input.history ?? [];
    // The chat history holds pairs; anything else is a dataset mistake, not a turn to drop.
    if (
      earlier.length % 2 !== 0 ||
      earlier.some((m, i) => m.role !== (i % 2 ? "assistant" : "user"))
    ) {
      throw new Error(`${input.id}: history must be user/assistant pairs`);
    }
    for (let i = 0; i < earlier.length; i += 2) {
      history.append(chatId, earlier[i]!.content, earlier[i + 1]!.content);
    }
    const now = noonIn(input.today, env.outlet.timezone);
    let failure: string | undefined;
    const handleTurn = createTurnHandler({
      lookupUser: createUserLookup(env.db),
      db: env.db,
      servers: env.servers,
      model: deps.model,
      observer: recordingObserver(output, deps.observer, {
        eval_case: testCase.id,
        eval_dataset: deps.dataset,
        instructions_version: COPILOT_INSTRUCTIONS_VERSION,
        model: deps.model.modelId,
      }),
      history,
      photos: new FakePhotoStore(),
      scorer: new RecordingScorer(),
      charts: new RecordingRenderer(),
      now: () => now,
      log: (message, error) => {
        const line = `${message}: ${String(error ?? "")}`;
        output.errors.push(line);
        if (message === "Copilot turn failed") failure = line;
      },
    });
    const senderId = env.telegramIdByRole[input.role];
    const event: ChannelEvent = {
      type: "message",
      id: `${chatId}-message`,
      platform: "telegram",
      conversation: { id: chatId, kind: "direct" },
      sender: { id: senderId, displayName: "Eval", bot: false },
      text: input.message,
      attachments: [],
      mentionedBot: false,
      raw: {},
    };
    const result = await handleTurn(event);
    output.reply = result.type === "reply" ? result.text : "";
    // The handler answers a failed or empty turn with the apology. Scoring it would pass a
    // `tool: null` case because the model was down, so the case becomes invalid instead.
    if (failure || output.reply === APOLOGY) {
      throw new Error(failure ?? "Copilot turn failed: no reply from the model");
    }
    return output;
  };
}
