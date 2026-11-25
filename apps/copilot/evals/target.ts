import { randomUUID } from "node:crypto";
import type { ChannelEvent } from "@anvia/channel";
import type { CompletionModel, JsonObject } from "@anvia/core";
import type { AgentObserver, AgentRunObserver } from "@anvia/core/observability";
import { COPILOT_INSTRUCTIONS_VERSION } from "@sisaku/agents";
import { menuItems } from "@sisaku/db";
import { eq } from "drizzle-orm";
import { ChatHistory } from "../src/history";
import { FakePhotoStore, RecordingRenderer, RecordingScorer } from "../src/testing/fakes";
import { APOLOGY, createTurnHandler } from "../src/turn";
import { createUserLookup } from "../src/users";
import { GuessStore, snapshot, type GuessLine } from "../src/waste/guess";
import type { CopilotInput } from "./cases";
import { noonIn } from "./clock";
import type { EvalEnvironment } from "./environment";
import { plantText, snapshotChanges, takeSnapshot } from "./isolation";

export type ToolCall = { name: string; args: unknown };

/** What one case's turn did: every tool call in order, the reply, and its trace when traced. */
export type TurnOutput = {
  calls: ToolCall[];
  reply: string;
  errors: string[];
  /** Rows the turn changed, in a dataset that compares the database (safety). */
  changes?: string[];
  trace?: { traceId: string; observationId?: string };
};

/** A turn the handler could not answer; keeps what it did, so its trace and calls are not lost. */
export class TurnFailed extends Error {
  constructor(
    message: string,
    readonly output: TurnOutput,
  ) {
    super(message);
  }
}

/** What a case's turn did, whether it succeeded or failed; undefined if it never finished. */
export const turnOutput = (result: { output?: TurnOutput | undefined; targetError?: unknown }) =>
  result.output ??
  (result.targetError instanceof TurnFailed ? result.targetError.output : undefined);

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
      if (run?.trace?.traceId) {
        const { traceId, observationId } = run.trace;
        // Lens attaches a score to its run only when it gets both ids.
        output.trace = { traceId, ...(observationId ? { observationId } : {}) };
      }
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

/** A guess store holding the case's open guess, as if its card had just been shown. */
async function guessStore(
  env: EvalEnvironment,
  input: CopilotInput,
  chat: { id: string; senderId: string; now: Date },
): Promise<GuessStore> {
  const store = new GuessStore(() => chat.now);
  if (!input.openGuess) return store;
  const user = await createUserLookup(env.db)(chat.senderId);
  if (!user) throw new Error(`No user for ${chat.senderId}`);
  const menu = await env.db.select().from(menuItems).where(eq(menuItems.outletId, user.outletId));
  const lines = input.openGuess.lines.map((line): GuessLine => {
    const found = menu.find((m) => m.id === line.item_id);
    if (!found) throw new Error(`${line.item_id} is not on the eval outlet's menu`);
    const { id, name, portionWeightKg } = found;
    return {
      item: { id, name, portionWeightKg: Number(portionWeightKg) },
      portionCount: line.portion_count,
    };
  });
  const draft = {
    lines,
    cause: input.openGuess.cause,
    loggedAt: chat.now.toISOString(),
    userSupplied: false,
    confidence: undefined,
  };
  store.add({
    ...draft,
    id: randomUUID(),
    userId: user.id,
    outletId: user.outletId,
    chatId: chat.id,
    timezone: user.timezone,
    source: "text",
    candidates: [],
    original: snapshot(draft),
    cardMessageId: "eval-card",
    createdAtMs: chat.now.getTime(),
  });
  return store;
}

export type TargetDeps = {
  env: EvalEnvironment;
  model: CompletionModel;
  /** The dataset the cases come from, recorded on each trace. */
  dataset: string;
  /**
   * Plants each case's text and compares the database around its turn. Cases must then run one
   * at a time.
   */
  isolated?: boolean;
  /** Lens, when configured. */
  observer?: AgentObserver | undefined;
};

/**
 * Runs one case through the real Copilot turn handler: the case's role at the eval outlet, its
 * history as earlier chat, its open guess if it has one, and the clock pinned to noon on its `today`.
 */
export function createCopilotTarget(deps: TargetDeps) {
  const { env } = deps;
  /** Puts back the last planted text; also called by the next case, if a turn timed out. */
  let restore = async () => {};

  async function isolate(
    input: CopilotInput,
    output: TurnOutput,
    run: () => Promise<TurnOutput>,
  ): Promise<TurnOutput> {
    await restore();
    const before = await takeSnapshot(env.db);
    // Kept per case: a turn that outlives its time limit must not undo the next case's text.
    const undo = input.plant ? await plantText(env.db, input.plant) : async () => {};
    restore = undo;
    try {
      return await run();
    } finally {
      await undo();
      output.changes = snapshotChanges(before, await takeSnapshot(env.db));
    }
  }

  return async (input: CopilotInput, testCase: { id: string }): Promise<TurnOutput> => {
    const output: TurnOutput = { calls: [], reply: "", errors: [] };
    const run = () => runTurn(input, testCase, output);
    return deps.isolated ? isolate(input, output, run) : run();
  };

  async function runTurn(
    input: CopilotInput,
    testCase: { id: string },
    output: TurnOutput,
  ): Promise<TurnOutput> {
    const chatId = `eval-${testCase.id}`;
    const history = new ChatHistory(20);
    const earlier = input.history ?? [];
    // The chat history holds pairs; anything else is a dataset mistake, not a turn to drop.
    if (
      earlier.length % 2 !== 0 ||
      earlier.some((m, i) => m.role !== (i % 2 ? "assistant" : "user"))
    ) {
      throw new Error(`${testCase.id}: history must be user/assistant pairs`);
    }
    for (let i = 0; i < earlier.length; i += 2) {
      history.append(chatId, earlier[i]!.content, earlier[i + 1]!.content);
    }
    const now = noonIn(input.today, env.outlet.timezone);
    const senderId = env.telegramIdByRole[input.role];
    const guesses = await guessStore(env, input, { id: chatId, senderId, now });
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
      guesses,
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
      throw new TurnFailed(failure ?? "Copilot turn failed: no reply from the model", output);
    }
    return output;
  }
}
