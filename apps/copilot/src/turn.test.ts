import type { ChannelConversationKind, ChannelEvent } from "@anvia/channel";
import {
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
} from "@anvia/core";
import type { AgentObserver, AgentRunStartArgs } from "@anvia/core/observability";
import { McpClient, McpClientGroup } from "@anvia/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { users } from "@sisaku/db";
import { createImpactServer } from "@sisaku/impact-mcp";
import { createKitchenServer } from "@sisaku/kitchen-mcp";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { ChatHistory } from "./history";
import { APOLOGY, createTurnHandler, unregisteredReply, type TurnDeps } from "./turn";
import { createUserLookup, type Db } from "./users";

const TELEGRAM_A = "1001"; // manager of outlet A
const TELEGRAM_STRANGER = "9999";

/** A Telegram event as @anvia/telegram normalises it. */
function message(
  text: string,
  senderId = TELEGRAM_A,
  kind: ChannelConversationKind = "direct",
): ChannelEvent {
  return {
    type: "message",
    id: `m-${Math.random()}`,
    platform: "telegram",
    conversation: { id: `chat-${senderId}`, kind },
    sender: { id: senderId, displayName: "Budi Santoso", bot: false },
    text,
    attachments: [],
    mentionedBot: false,
    raw: {},
  };
}

type Step = { toolCall: { name: string; input: JsonValue } } | { text: string } | { error: Error };

/** Replays scripted steps and records every request, including the tools it was offered. */
class ScriptedModel implements CompletionModel {
  readonly provider = "stub";
  readonly modelId = "scripted";
  readonly capabilities = {
    streaming: false,
    tools: true,
    toolChoice: true,
    imageInput: false,
    documentInput: false,
    outputSchema: false,
    reasoning: false,
  };
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedModel ran out of steps");
    if ("error" in step) throw step.error;
    const base = { usage: Usage.empty(), rawResponse: {} };
    if ("text" in step) {
      return { ...base, choice: [{ type: "text", text: step.text }], finishReason: "stop" };
    }
    return {
      ...base,
      choice: [
        {
          type: "tool-call",
          toolCallId: `call-${this.requests.length}`,
          toolName: step.toolCall.name,
          input: step.toolCall.input,
        },
      ],
      finishReason: "tool-calls",
    };
  }

  /** The tool result text the agent sent back on the latest request. */
  lastToolResult(): string {
    const last = this.requests.at(-1)?.chatHistory.at(-1);
    if (last?.role !== "tool") throw new Error("last message is not a tool result");
    return JSON.stringify(last.content);
  }
}

type RecordedRun = {
  start: AgentRunStartArgs;
  generations: number;
  tools: string[];
  status?: string;
  error?: unknown;
};

/** Stands in for Anvia Lens: records one run per trace with its LLM and tool spans. */
class RecordingObserver implements AgentObserver {
  readonly runs: RecordedRun[] = [];
  constructor(private readonly failing = false) {}

  startRun(start: AgentRunStartArgs) {
    if (this.failing) throw new Error("Lens is down");
    const run: RecordedRun = { start, generations: 0, tools: [] };
    this.runs.push(run);
    return {
      startGeneration: () => {
        run.generations++;
        return { end: () => undefined };
      },
      startTool: (args: { toolName: string }) => {
        run.tools.push(args.toolName);
        return { end: () => undefined };
      },
      end: (args: { status: string }) => {
        run.status = args.status;
      },
      error: (args: { status: string; error: unknown }) => {
        run.status = args.status;
        run.error = args.error;
      },
    };
  }
}

function inMemoryClient(name: string, connect: (transport: InMemoryTransport) => Promise<void>) {
  return new McpClient({
    name,
    versionNegotiation: { mode: "auto" },
    transport: {
      type: "custom",
      create: async () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await connect(serverSide);
        return clientSide;
      },
    },
  });
}

describe.skipIf(!testDbUrl)("Copilot turn handler", () => {
  let db: Db;
  let pool: Awaited<ReturnType<typeof setupTestDb>>["pool"];
  let mcp: McpClientGroup;
  let history: ChatHistory;

  beforeAll(async () => {
    ({ db, pool } = await setupTestDb());
    await db
      .update(users)
      .set({ telegramUserId: TELEGRAM_A, role: "manager" })
      .where(eq(users.id, ids.staffA));
    mcp = await McpClientGroup.connect({
      clients: [
        inMemoryClient("kitchen", (t) => createKitchenServer(db).connect(t)),
        inMemoryClient("impact", (t) => createImpactServer(db).connect(t)),
      ],
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await pool?.end();
  });

  beforeEach(() => {
    history = new ChatHistory(20);
  });

  function handler(model: CompletionModel, observer: AgentObserver, extra: Partial<TurnDeps> = {}) {
    return createTurnHandler({
      lookupUser: createUserLookup(db),
      servers: mcp.servers,
      model,
      observer,
      history,
      now: () => new Date("2026-03-03T03:00:00Z"),
      log: () => undefined,
      ...extra,
    });
  }

  it("answers an unregistered sender with their Telegram ID, without the model or a trace", async () => {
    const model = new ScriptedModel([]);
    const observer = new RecordingObserver();
    const result = await handler(model, observer)(message("halo", TELEGRAM_STRANGER));
    expect(result).toEqual({ type: "reply", text: unregisteredReply(TELEGRAM_STRANGER) });
    expect(unregisteredReply(TELEGRAM_STRANGER)).toContain(TELEGRAM_STRANGER);
    expect(model.requests).toHaveLength(0);
    expect(observer.runs).toHaveLength(0);
  });

  it("ignores group chats, even from a registered user", async () => {
    const model = new ScriptedModel([]);
    const result = await handler(
      model,
      new RecordingObserver(),
    )(message("halo", TELEGRAM_A, "group"));
    expect(result).toEqual({ type: "skip" });
    expect(model.requests).toHaveLength(0);
  });

  it("offers the model exactly the allowlisted tools, with no outlet_id anywhere", async () => {
    const model = new ScriptedModel([{ text: "Halo!" }]);
    const result = await handler(model, new RecordingObserver())(message("halo"));
    expect(result).toEqual({ type: "reply", text: "Halo!" });

    const tools = model.requests[0]!.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compute_co2e",
      "get_factor",
      "get_menu",
      "get_prep_log",
      "get_sales",
      "query_waste",
    ]);
    expect(tools.map((t) => t.name)).not.toContain("draft_pickup");
    expect(JSON.stringify(tools)).not.toContain("outlet_id");
    expect(JSON.stringify(tools)).not.toContain("confirmed_by");
  });

  it("scopes tool calls to the sender's outlet, whatever outlet the model names", async () => {
    const day = { from: "2026-03-01", to: "2026-03-01" };
    const model = new ScriptedModel([
      { toolCall: { name: "query_waste", input: { filters: day, group_by: "none" } } },
      {
        toolCall: {
          name: "query_waste",
          input: { filters: { ...day, outlet_id: ids.outletB }, group_by: "none" },
        },
      },
      { text: "Total limbah 0,36 kg." },
    ]);
    await handler(model, new RecordingObserver())(message("berapa limbah tanggal 1 Maret?"));

    // Outlet A's waste on local day 2026-03-01 is 0.36 kg of rendang. Outlet B's 0.9 kg of soto
    // on that day never appears, even when the model asked for outlet B.
    const [, firstResult, secondResult] = model.requests.map((r) =>
      JSON.stringify(r.chatHistory.at(-1)),
    );
    for (const result of [firstResult, secondResult]) {
      expect(result).toContain(ids.outletA);
      expect(result).not.toContain(ids.outletB);
      expect(result).toContain('\\"waste_kg\\":0.36');
      expect(result).not.toContain("0.9");
    }
  });

  it("records one trace per turn with LLM and tool spans and labels, but no names", async () => {
    const model = new ScriptedModel([
      { toolCall: { name: "get_menu", input: {} } },
      { text: "Menu: Nasi Putih, Rendang Sapi." },
    ]);
    const observer = new RecordingObserver();
    await handler(model, observer)(message("apa menunya?"));

    expect(observer.runs).toHaveLength(1);
    const [run] = observer.runs;
    expect(run!.generations).toBe(2);
    expect(run!.tools).toEqual(["get_menu"]);
    expect(run!.status).toBe("completed");
    expect(run!.start.trace?.metadata).toEqual({
      agent: "copilot",
      outlet_id: ids.outletA,
      user_id: ids.staffA,
      role: "manager",
      chat_id: `chat-${TELEGRAM_A}`,
    });
    const labels = JSON.stringify(run!.start.trace);
    expect(labels).not.toContain("Budi");
    expect(labels).not.toContain("Staff A");
  });

  it("gives the user's role and the outlet's local date to the model", async () => {
    const model = new ScriptedModel([{ text: "ok" }]);
    await handler(model, new RecordingObserver())(message("halo"));
    // 2026-03-03T03:00Z is 10:00 in Asia/Jakarta.
    expect(model.requests[0]!.instructions).toContain("Current date: 2026-03-03 (Asia/Jakarta)");
    expect(model.requests[0]!.instructions).toContain("role: manager");
  });

  it("apologises when the model fails, and records the error on the trace", async () => {
    const observer = new RecordingObserver();
    const model = new ScriptedModel([{ error: new Error("upstream timeout: secret detail") }]);
    const result = await handler(model, observer)(message("halo"));
    expect(result).toEqual({ type: "reply", text: APOLOGY });
    expect(observer.runs[0]!.status).toBe("failed");
    expect(String(observer.runs[0]!.error)).toContain("upstream timeout");
  });

  it("still replies when Lens is down", async () => {
    const model = new ScriptedModel([{ text: "Halo!" }]);
    const result = await handler(model, new RecordingObserver(true))(message("halo"));
    expect(result).toEqual({ type: "reply", text: "Halo!" });
  });

  it("remembers earlier messages of the conversation", async () => {
    const model = new ScriptedModel([{ text: "Halo Budi!" }, { text: "Kemarin juga sedikit." }]);
    const handle = handler(model, new RecordingObserver());
    await handle(message("halo"));
    await handle(message("bagaimana kemarin?"));
    const history = model.requests[1]!.chatHistory.map((m) => [m.role, m.content]);
    expect(history).toEqual([
      ["user", "halo"],
      ["assistant", "Halo Budi!"],
      ["user", "bagaimana kemarin?"],
    ]);
  });
});
