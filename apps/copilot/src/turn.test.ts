import { randomUUID } from "node:crypto";
import type { ChannelConversationKind, ChannelEvent } from "@anvia/channel";
import {
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
  type ToolCallContext,
} from "@anvia/core";
import type { AgentObserver, AgentRunStartArgs } from "@anvia/core/observability";
import { McpClient, McpClientGroup } from "@anvia/mcp";
import { COPILOT_INSTRUCTIONS_VERSION } from "@sisaku/agents";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { agentRuns, menuItems, sales, users, wasteEntries } from "@sisaku/db";
import { createImpactServer } from "@sisaku/impact-mcp";
import { createKitchenServer } from "@sisaku/kitchen-mcp";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ids, setupTestDb, testDbUrl } from "../../../packages/kitchen-mcp/src/test-fixture";
import { ChatHistory } from "./history";
import {
  APOLOGY,
  createTurnHandler,
  REPLACED_CARD_TEXT,
  UNSUPPORTED_ATTACHMENT,
  unregisteredReply,
  type CardEdit,
  type TurnDeps,
  type TurnResult,
} from "./turn";
import {
  ALREADY_CANCELLED_TEXT,
  ALREADY_REPLACED_TEXT,
  ALREADY_SAVED_TEXT,
  ASK_CORRECTION_TEXT,
  EXPIRED_TEXT,
  NOT_READY_TEXT,
  NOT_YOURS_TEXT,
  SAVE_FAILED_TEXT,
} from "./waste/actions";
import { actionId, parseActionId } from "./waste/card";
import { createChartRenderer, type ChartRenderer, type ChartSpec } from "./charts/render";
import { createUserLookup, type Db } from "./users";
import type { FeedbackScorer } from "./waste/feedback";
import { GuessStore } from "./waste/guess";
import type { PhotoStore } from "./waste/photos";

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
    imageInput: true,
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
  traceId: string;
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
    // Unique per run, so runs from different tests never share a trace id in the database.
    const run: RecordedRun = { start, traceId: randomUUID(), generations: 0, tools: [] };
    this.runs.push(run);
    return {
      trace: { traceId: run.traceId },
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

/** Stands in for the photos volume. */
class FakePhotoStore implements PhotoStore {
  readonly saved: { path: string; data: Buffer }[] = [];
  async save(path: string, data: Buffer) {
    this.saved.push({ path, data });
    return path;
  }
}

/** Stands in for the chart renderer: keeps every spec, returns fake PNG bytes. */
class RecordingRenderer implements ChartRenderer {
  readonly specs: ChartSpec[] = [];
  constructor(private readonly failing = false) {}
  async render(spec: ChartSpec) {
    if (this.failing) throw new Error("resvg crashed");
    this.specs.push(spec);
    return Buffer.from("png");
  }
  /** The data rows of the latest chart. */
  values() {
    return (this.specs.at(-1)!.data as { values: unknown[] }).values;
  }
}

/** Stands in for Lens scores. */
class RecordingScorer implements FeedbackScorer {
  readonly scores: Parameters<FeedbackScorer["score"]>[0][] = [];
  score(args: Parameters<FeedbackScorer["score"]>[0]) {
    this.scores.push(args);
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
  let clock: Date;
  let guesses: GuessStore;
  let photos: FakePhotoStore;
  let scorer: RecordingScorer;
  let charts: RecordingRenderer;

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
    clock = new Date("2026-03-03T03:00:00Z");
    guesses = new GuessStore(() => clock);
    photos = new FakePhotoStore();
    scorer = new RecordingScorer();
    charts = new RecordingRenderer();
  });

  function handler(model: CompletionModel, observer: AgentObserver, extra: Partial<TurnDeps> = {}) {
    return createTurnHandler({
      lookupUser: createUserLookup(db),
      db,
      servers: mcp.servers,
      model,
      observer,
      history,
      photos,
      scorer,
      charts,
      guesses,
      now: () => clock,
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

  it("offers the allowlisted tools and propose_waste_entry, never log_waste or outlet_id", async () => {
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
      "list_entries",
      "propose_waste_entry",
      "query_waste",
      "send_chart",
      "update_entry",
    ]);
    expect(tools.map((t) => t.name)).not.toContain("draft_pickup");
    expect(tools.map((t) => t.name)).not.toContain("log_waste");
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
      instructions_version: COPILOT_INSTRUCTIONS_VERSION,
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

  it("gives the outlet's menu, names and ids, so the model needs no get_menu call", async () => {
    const model = new ScriptedModel([{ text: "ok" }]);
    await handler(model, new RecordingObserver())(message("halo"));
    const instructions = model.requests[0]!.instructions!;
    expect(instructions).toContain(`${ids.nasi}: Nasi Putih`);
    expect(instructions).toContain(`${ids.rendang}: Rendang Sapi`);
    expect(instructions).not.toContain("Soto Ayam"); // outlet B's menu
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
  describe("data questions and charts (ADR 0015)", () => {
    // Outlet A, local days 2026-02-10..12, apart from the dates other tests write to.
    // Rendang 0.120 kg and Rp 13,000 per portion; nasi 0.200 kg.
    const range = { from: "2026-02-10", to: "2026-02-12" };
    const noon = (day: string) => new Date(`${day}T05:00:00Z`); // 12:00 in Asia/Jakarta

    beforeAll(async () => {
      const waste = (itemId: string, day: string, kg: string, portions: number, cause: string) => ({
        outletId: ids.outletA,
        itemId,
        loggedAt: noon(day),
        weightKg: kg,
        portionCount: portions,
        cause,
        source: "text" as const,
      });
      await db
        .insert(wasteEntries)
        .values([
          waste(ids.rendang, "2026-02-10", "0.240", 2, "over_prep"),
          waste(ids.nasi, "2026-02-11", "1.000", 5, "over_prep"),
          waste(ids.rendang, "2026-02-12", "0.600", 5, "spoilage"),
          { ...waste(ids.soto, "2026-02-11", "9.000", 30, "spoilage"), outletId: ids.outletB },
        ]);
      await db.insert(sales).values(
        [
          ["2026-02-10", 40],
          ["2026-02-11", 42],
          ["2026-02-12", 20],
        ].map(([date, qtySold]) => ({
          outletId: ids.outletA,
          itemId: ids.rendang,
          date: date as string,
          qtySold: qtySold as number,
        })),
      );
    });

    function chartTurn(input: JsonValue, reply = "Limbah naik pada 12 Feb.") {
      return new ScriptedModel([{ toolCall: { name: "send_chart", input } }, { text: reply }]);
    }

    it("sends a waste trend after the text reply, with the outlet's numbers per day", async () => {
      const model = chartTurn({ kind: "waste_trend", ...range, metric: "waste_kg" });
      const result = await handler(model, new RecordingObserver())(message("tren limbah?"));

      expect(charts.values()).toEqual([
        { date: "2026-02-10", value: 0.24 },
        { date: "2026-02-11", value: 1 },
        { date: "2026-02-12", value: 0.6 },
      ]);
      expect(result).toEqual({
        type: "reply",
        text: "Limbah naik pada 12 Feb.",
        chart: { png: Buffer.from("png"), title: "Limbah per hari (kg), 10–12 Feb 2026" },
      });
      expect(model.lastToolResult()).toContain('"sent":true');
    });

    it("fills days without waste with zero, for one item, in rupiah", async () => {
      const model = chartTurn({
        kind: "waste_trend",
        ...range,
        metric: "cost_idr",
        item_id: ids.rendang,
      });
      const result = await handler(model, new RecordingObserver())(message("biaya rendang?"));
      expect(charts.values()).toEqual([
        { date: "2026-02-10", value: 26000 },
        { date: "2026-02-11", value: 0 },
        { date: "2026-02-12", value: 65000 },
      ]);
      expect(result).toMatchObject({
        chart: { title: "Limbah Rendang Sapi per hari (Rp), 10–12 Feb 2026" },
      });
    });

    it("compares one item's waste with its sales on the same days", async () => {
      const model = chartTurn({ kind: "waste_vs_sales", ...range, item_id: ids.rendang });
      const result = await handler(model, new RecordingObserver())(message("kenapa rendang naik?"));
      expect(charts.values()).toEqual([
        { date: "2026-02-10", series: "Limbah", portions: 2 },
        { date: "2026-02-11", series: "Limbah", portions: 0 },
        { date: "2026-02-12", series: "Limbah", portions: 5 },
        { date: "2026-02-10", series: "Terjual", portions: 40 },
        { date: "2026-02-11", series: "Terjual", portions: 42 },
        { date: "2026-02-12", series: "Terjual", portions: 20 },
      ]);
      expect(result).toMatchObject({
        chart: { title: "Rendang Sapi: limbah vs terjual (porsi), 10–12 Feb 2026" },
      });
    });

    it("ranks waste by cause and by item, largest first", async () => {
      await handler(
        chartTurn({ kind: "waste_breakdown", ...range, metric: "waste_kg", by: "cause" }),
        new RecordingObserver(),
      )(message("penyebab terbesar?"));
      expect(charts.values()).toEqual([
        { label: "Kelebihan masak", value: 1.24 },
        { label: "Basi", value: 0.6 },
      ]);

      const result = await handler(
        chartTurn({ kind: "waste_breakdown", ...range, metric: "waste_kg", by: "item" }),
        new RecordingObserver(),
      )(message("menu terbesar?"));
      expect(charts.values()).toEqual([
        { label: "Nasi Putih", value: 1 },
        { label: "Rendang Sapi", value: 0.84 },
      ]);
      expect(result).toMatchObject({
        chart: { title: "Limbah per menu (kg), 10–12 Feb 2026" },
      });
    });

    it("sends no chart when the range has no waste", async () => {
      const model = chartTurn(
        { kind: "waste_trend", from: "2026-02-01", to: "2026-02-05", metric: "waste_kg" },
        "Tidak ada limbah tercatat.",
      );
      const result = await handler(model, new RecordingObserver())(message("tren awal Feb?"));
      expect(result).toEqual({ type: "reply", text: "Tidak ada limbah tercatat." });
      expect(charts.specs).toHaveLength(0);
      expect(model.lastToolResult()).toContain('"reason":"no_data"');
    });

    it("sends no trend for a single day", async () => {
      const model = chartTurn({
        kind: "waste_trend",
        from: "2026-02-12",
        to: "2026-02-12",
        metric: "waste_kg",
      });
      const result = await handler(model, new RecordingObserver())(message("tren hari ini?"));
      expect(result).not.toHaveProperty("chart");
      expect(model.lastToolResult()).toContain('"reason":"no_data"');
    });

    it("refuses a range longer than 92 days, an item of another outlet, and a second chart", async () => {
      const tooLong = chartTurn({
        kind: "waste_trend",
        from: "2025-11-01",
        to: "2026-02-12",
        metric: "waste_kg",
      });
      expect(await handler(tooLong, new RecordingObserver())(message("tren?"))).not.toHaveProperty(
        "chart",
      );
      expect(tooLong.lastToolResult()).toContain("92 days");

      const otherOutlet = chartTurn({ kind: "waste_vs_sales", ...range, item_id: ids.soto });
      expect(
        await handler(otherOutlet, new RecordingObserver())(message("soto?")),
      ).not.toHaveProperty("chart");
      expect(otherOutlet.lastToolResult()).toContain("not on this outlet's menu");

      const twice = new ScriptedModel([
        { toolCall: { name: "send_chart", input: { kind: "waste_trend", ...range } } },
        {
          toolCall: {
            name: "send_chart",
            input: { kind: "waste_breakdown", ...range, by: "item" },
          },
        },
        { text: "Ini grafiknya." },
      ]);
      const result = await handler(twice, new RecordingObserver())(message("dua grafik"));
      expect(twice.lastToolResult()).toContain("one chart per turn");
      expect(charts.specs).toHaveLength(1);
      expect(result).toMatchObject({ chart: { title: "Limbah per hari (kg), 10–12 Feb 2026" } });
    });

    it("rejects an impossible date instead of shifting or emptying the chart", async () => {
      const model = chartTurn(
        { kind: "waste_trend", from: "2026-02-10", to: "2026-13-01" },
        "Tanggalnya tidak valid.",
      );
      const result = await handler(model, new RecordingObserver())(message("tren?"));
      expect(result).toEqual({ type: "reply", text: "Tanggalnya tidak valid." });
      expect(charts.specs).toHaveLength(0);
      // An input error the model can fix, not a "no data" answer.
      expect(model.lastToolResult()).not.toContain("no_data");
      expect(model.lastToolResult()).toMatch(/date/i);
    });

    it("answers in text only when the chart cannot be drawn", async () => {
      const model = chartTurn({ kind: "waste_trend", ...range }, "Total 1,84 kg.");
      const result = await handler(model, new RecordingObserver(), {
        charts: new RecordingRenderer(true),
      })(message("tren?"));
      expect(result).toEqual({ type: "reply", text: "Total 1,84 kg." });
      expect(model.lastToolResult()).toContain("could not be drawn");
    });

    it("draws a real PNG with the bundled font", async () => {
      const model = chartTurn({ kind: "waste_vs_sales", ...range, item_id: ids.rendang });
      const result = await handler(model, new RecordingObserver(), {
        charts: await createChartRenderer(),
      })(message("kenapa rendang naik?"));
      const png = (result as { chart: { png: Buffer } }).chart.png;
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(png.readUInt32BE(16)).toBeGreaterThan(500); // width from the IHDR chunk
    });
  });

  describe("waste logging (ADR 0014)", () => {
    const PHOTO = Buffer.from("fake-jpeg-bytes");
    const io = {
      loadAttachment: async () => ({ type: "data" as const, data: PHOTO.toString("base64") }),
    };
    const TELEGRAM_A2 = "1003"; // another user of outlet A

    beforeAll(async () => {
      await db.insert(users).values({
        id: "00000000-0000-4000-8000-000000000303",
        outletId: ids.outletA,
        name: "Staff A2",
        telegramUserId: TELEGRAM_A2,
      });
    });

    function photoMessage(caption = "", senderId = TELEGRAM_A): ChannelEvent {
      const base = message(caption, senderId) as Extract<ChannelEvent, { type: "message" }>;
      return {
        ...base,
        attachments: [
          { id: "photo-1", type: "image", mediaType: "image/jpeg", size: PHOTO.length },
        ],
      };
    }

    function tap(actionId: string, senderId = TELEGRAM_A, messageId = "card-1"): ChannelEvent {
      return {
        type: "action",
        id: `a-${Math.random()}`,
        platform: "telegram",
        conversation: { id: `chat-${senderId}`, kind: "direct" },
        sender: { id: senderId, displayName: "Budi", bot: false },
        messageId,
        actionId,
        raw: {},
      };
    }

    type Reply = Extract<TurnResult, { type: "reply" }>;
    function asReply(result: TurnResult): Reply {
      if (result.type !== "reply") throw new Error(`expected a reply, got ${result.type}`);
      return result;
    }
    function button(result: TurnResult, label: string): string {
      const action = asReply(result).actions?.find((a) => a.label === label);
      if (!action) throw new Error(`no ${label} button`);
      return action.id;
    }
    function editOf(result: TurnResult): CardEdit {
      if (result.type === "skip" || !result.edits?.[0]) throw new Error("expected a card edit");
      return result.edits[0];
    }
    const guessIdOf = (result: TurnResult) =>
      parseActionId(asReply(result).actions![0]!.id)!.guessId;

    const propose = (input: JsonValue): Step => ({
      toolCall: { name: "propose_waste_entry", input },
    });
    const entriesOfRun = (runId: string) =>
      db.select().from(wasteEntries).where(eq(wasteEntries.runId, runId));

    it("saves a confident photo guess only on Simpan: one entry per line, photo, run and score", async () => {
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        { toolCall: { name: "get_menu", input: {} } },
        propose({
          lines: [
            { item_id: ids.nasi, portion_count: 3 },
            { item_id: ids.rendang, portion_count: 2 },
          ],
          confidence: 0.85,
          cause: "over_prep",
        }),
        { text: "Ini tebakan saya." },
      ]);
      const handle = handler(model, observer);
      const card = asReply(await handle(photoMessage("sisa siang"), io));
      expect(card.text).toContain("1. Nasi Putih: 3 porsi");
      expect(card.text).toContain("2. Rendang Sapi: 2 porsi");
      expect(card.text).toContain("Penyebab: Kelebihan masak");
      expect(card.actions?.map((a) => a.label)).toEqual(["Simpan", "Ubah", "Batal"]);
      // The model saw the photo as an image.
      expect(JSON.stringify(model.requests[0]!.chatHistory.at(-1))).toContain('"type":"image"');
      expect(photos.saved).toHaveLength(0);

      const saved = await handle(tap(button(card, "Simpan")));
      expect(editOf(saved).text).toContain("Tersimpan ✓");
      expect(editOf(saved).actions).toBeUndefined();

      const guessId = guessIdOf(card);
      expect(photos.saved).toEqual([{ path: `${ids.outletA}/${guessId}.jpg`, data: PHOTO }]);
      const trace1 = observer.runs[0]!.traceId;
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.traceId, trace1));
      expect(run).toMatchObject({
        agent: "copilot",
        trigger: "telegram",
        status: "succeeded",
        instructionsVersion: COPILOT_INSTRUCTIONS_VERSION,
      });
      const entries = await entriesOfRun(run!.id);
      expect(entries).toHaveLength(2);
      for (const e of entries) {
        expect(e).toMatchObject({
          outletId: ids.outletA,
          source: "photo",
          confidence: 0.85,
          cause: "over_prep",
          confirmedBy: ids.staffA,
          photoPath: `${ids.outletA}/${guessId}.jpg`,
        });
      }
      expect(entries.map((e) => e.weightKg).sort()).toEqual(["0.240", "0.600"]);
      expect(scorer.scores).toEqual([
        {
          traceId: trace1,
          name: "waste_guess_accepted",
          value: 1,
          metadata: { fields: [], unsure: false, lines: 2 },
        },
      ]);

      // A double tap saves nothing more and leaves the "Tersimpan ✓" card alone.
      const again = asReply(await handle(tap(button(card, "Simpan"))));
      expect(again).toEqual({ type: "reply", text: ALREADY_SAVED_TEXT, edits: [] });
      expect(await entriesOfRun(run!.id)).toHaveLength(2);
    });

    it("saves nothing when one line fails, and lets the user tap Simpan again", async () => {
      const esTeh = {
        id: "00000000-0000-4000-8000-000000000109",
        outletId: ids.outletA,
        name: "Es Teh",
        category: "drink",
        costPerPortion: "3000",
        portionWeightKg: "0.250",
        foodCategory: "other",
      };
      await db.insert(menuItems).values(esTeh);
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        propose({
          lines: [
            { item_id: ids.nasi, portion_count: 1 },
            { item_id: esTeh.id, portion_count: 2 },
          ],
          cause: "over_prep",
          confidence: 0.9,
        }),
        { text: "ok" },
      ]);
      const handle = handler(model, observer);
      const card = await handle(photoMessage(), io);
      const traceId = observer.runs[0]!.traceId;
      const entriesOfTrace = () =>
        db
          .select({ id: wasteEntries.id })
          .from(wasteEntries)
          .innerJoin(agentRuns, eq(agentRuns.id, wasteEntries.runId))
          .where(eq(agentRuns.traceId, traceId));

      // Es Teh leaves the menu before Simpan, so log_waste rejects the second line.
      await db.delete(menuItems).where(eq(menuItems.id, esTeh.id));
      const failed = asReply(await handle(tap(button(card, "Simpan"))));
      expect(failed.text).toBe(SAVE_FAILED_TEXT);
      expect(failed.edits ?? []).toEqual([]);
      expect(await entriesOfTrace()).toEqual([]);

      await db.insert(menuItems).values(esTeh);
      const saved = await handle(tap(button(card, "Simpan")));
      expect(editOf(saved).text).toContain("Tersimpan ✓");
      expect(await entriesOfTrace()).toHaveLength(2);
      // The retry reuses the photo and the run instead of writing them again.
      expect(photos.saved).toHaveLength(1);
      expect(await db.select().from(agentRuns).where(eq(agentRuns.traceId, traceId))).toHaveLength(
        1,
      );
    });

    /** MCP servers whose log_waste saves but loses its first reply (e.g. a dropped connection). */
    function serversLosingFirstSaveReply(): typeof mcp.servers {
      let loseReply = true;
      return mcp.servers.map((server) => ({
        ...server,
        tools: server.tools.map((tool) =>
          tool.mcp.remoteName !== "log_waste"
            ? tool
            : {
                ...tool,
                async call(args: unknown, context?: ToolCallContext) {
                  const result = await tool.call(args, context);
                  if (loseReply) {
                    loseReply = false;
                    throw new Error("connection reset");
                  }
                  return result;
                },
              },
        ),
      })) as typeof mcp.servers;
    }

    it("does not log twice when a save committed but its reply was lost", async () => {
      const servers = serversLosingFirstSaveReply();
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        propose({ lines: [{ item_id: ids.nasi, portion_count: 2 }], cause: "spoilage" }),
        { text: "ok" },
      ]);
      const handle = handler(model, observer, { servers });
      const card = await handle(message("nasi 2 porsi basi"));
      expect(asReply(await handle(tap(button(card, "Simpan")))).text).toBe(SAVE_FAILED_TEXT);
      expect(editOf(await handle(tap(button(card, "Simpan")))).text).toContain("Tersimpan ✓");

      const runs = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.traceId, observer.runs[0]!.traceId));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
      expect(await entriesOfRun(runs[0]!.id)).toHaveLength(1);
    });

    it("does not log twice when the user corrects a guess after a save whose reply was lost", async () => {
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 3 }],
          cause: "spoilage",
          confidence: 0.9,
        }),
        { text: "ok" },
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 4 }],
          cause: "plate_waste",
          corrects_open_guess: true,
        }),
        { text: "ok" },
      ]);
      const handle = handler(model, observer, { servers: serversLosingFirstSaveReply() });
      const card = await handle(photoMessage(), io);
      expect(asReply(await handle(tap(button(card, "Simpan")))).text).toBe(SAVE_FAILED_TEXT);
      await handle(tap(button(card, "Ubah")));
      const corrected = await handle(message("4 porsi, sisa piring"));
      const saved = editOf(await handle(tap(button(corrected, "Simpan"))));

      // The first save had gone through: its entry is shown as stored, and nothing is logged again.
      expect(saved.text).toContain("Nasi Putih: 3 porsi");
      // The cause line, too, is the stored one, not the correction's.
      expect(saved.text).toContain("Penyebab: Basi");
      expect(saved.text).not.toContain("Sisa piring");
      const runs = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.traceId, observer.runs[0]!.traceId));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("succeeded");
      expect(await entriesOfRun(runs[0]!.id)).toHaveLength(1);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.traceId, observer.runs[1]!.traceId)),
      ).toEqual([]);
      expect(photos.saved).toHaveLength(1);
    });

    it("never saves an unsure photo guess until the user supplies the item and portions", async () => {
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        { toolCall: { name: "get_menu", input: {} } },
        propose({ candidate_item_ids: [ids.nasi, ids.rendang], confidence: 0.4 }),
        { text: "Kurang yakin." },
        propose({ lines: [{ item_id: ids.nasi, portion_count: 2 }], corrects_open_guess: true }),
        { text: "Oke." },
      ]);
      const handle = handler(model, observer);
      const card = asReply(await handle(photoMessage(), io));
      expect(card.text).toContain("kurang yakin");
      expect(card.actions?.map((a) => a.label)).toEqual(["Nasi Putih", "Rendang Sapi", "Batal"]);

      // A forged Simpan tap on the unsure guess is refused and logs nothing.
      const guessId = guessIdOf(card);
      const forged = asReply(await handle(tap(actionId(guessId, "s"))));
      expect(forged.text).toBe(NOT_READY_TEXT);
      expect(photos.saved).toHaveLength(0);
      expect(
        await db.select().from(agentRuns).where(eq(agentRuns.traceId, observer.runs[0]!.traceId)),
      ).toEqual([]);

      // Picking a candidate asks for the portion count; typing it makes a guess that needs a cause.
      const picked = await handle(tap(button(card, "Nasi Putih"), TELEGRAM_A, "card-7"));
      expect(editOf(picked).text).toContain("Nasi Putih: berapa porsi");
      const revised = asReply(await handle(message("2 porsi")));
      expect(revised.text).toContain("Nasi Putih: 2 porsi");
      expect(revised.edits).toEqual([{ messageId: "card-7", text: REPLACED_CARD_TEXT }]);
      expect(revised.actions?.map((a) => a.label)).toEqual([
        "Kelebihan masak",
        "Basi",
        "Sisa piring",
        "Salah masak",
        "Kedaluwarsa",
        "Batal",
      ]);
      const ready = await handle(tap(button(revised, "Basi")));
      expect(editOf(ready).actions?.map((a) => a.label)).toEqual(["Simpan", "Ubah", "Batal"]);

      const saveId = editOf(ready).actions![0]!.id;
      expect(editOf(await handle(tap(saveId))).text).toContain("Tersimpan ✓");
      const trace2 = observer.runs[1]!.traceId;
      const [run] = await db.select().from(agentRuns).where(eq(agentRuns.traceId, trace2));
      const [entry] = await entriesOfRun(run!.id);
      expect(entry).toMatchObject({ source: "photo", portionCount: 2, cause: "spoilage" });
      // The photo keeps the unsure guess's id; the score marks the guess as not accepted.
      expect(photos.saved.map((p) => p.path)).toEqual([
        `${ids.outletA}/${parseActionId(saveId)!.guessId}.jpg`,
      ]);
      expect(scorer.scores).toEqual([
        {
          traceId: trace2,
          name: "waste_guess_accepted",
          value: 0,
          metadata: { fields: ["lines_added"], unsure: true, lines: 1 },
        },
      ]);
    });

    it("lets the user correct a text guess with Ubah, then scores the changed fields", async () => {
      const observer = new RecordingObserver();
      const model = new ScriptedModel([
        propose({ lines: [{ item_id: ids.nasi, portion_count: 3 }], cause: "over_prep" }),
        { text: "Siap." },
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 4 }],
          cause: "over_prep",
          corrects_open_guess: true,
        }),
        { text: "Sudah dikoreksi." },
      ]);
      const handle = handler(model, observer);
      const card = asReply(await handle(message("nasi 3 porsi kebuang, kebanyakan masak")));
      card.onSent?.("card-10");
      const ask = asReply(await handle(tap(button(card, "Ubah"), TELEGRAM_A, "card-10")));
      expect(ask.text).toBe(ASK_CORRECTION_TEXT);

      const revised = asReply(await handle(message("4 porsi")));
      // The model was told about the open guess.
      expect(model.requests[2]!.instructions).toContain("Open waste guess: Nasi Putih");
      expect(revised.edits).toEqual([{ messageId: "card-10", text: REPLACED_CARD_TEXT }]);
      // The replaced card's buttons are dead, and its "Diganti" text stays.
      expect(await handle(tap(button(card, "Simpan")))).toEqual({
        type: "reply",
        text: ALREADY_REPLACED_TEXT,
        edits: [],
      });

      await handle(tap(button(revised, "Simpan")));
      const [run] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.traceId, observer.runs[1]!.traceId));
      const [entry] = await entriesOfRun(run!.id);
      expect(entry).toMatchObject({
        source: "text",
        portionCount: 4,
        weightKg: "0.800",
        photoPath: null,
        confidence: null,
      });
      expect(scorer.scores[0]).toMatchObject({ value: 0, metadata: { fields: ["portion_count"] } });
    });

    it("keeps an open photo guess when the user reports different waste by text", async () => {
      const model = new ScriptedModel([
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 1 }],
          cause: "spoilage",
          confidence: 0.9,
        }),
        { text: "ok" },
        propose({ lines: [{ item_id: ids.rendang, portion_count: 2 }], cause: "over_prep" }),
        { text: "ok" },
      ]);
      const handle = handler(model, new RecordingObserver());
      const photoCard = await handle(photoMessage(), io);
      const textCard = asReply(await handle(message("rendang 2 porsi kebanyakan masak")));
      expect(textCard.edits).toEqual([]);
      await handle(tap(button(textCard, "Simpan")));
      // The text entry carries no photo, and the photo guess can still be saved.
      expect(photos.saved).toHaveLength(0);
      await handle(tap(button(photoCard, "Simpan")));
      expect(photos.saved).toHaveLength(1);
    });

    it("drops a guess on Batal or after 30 minutes, without saving a photo", async () => {
      const model = new ScriptedModel([
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 1 }],
          cause: "spoilage",
          confidence: 0.9,
        }),
        { text: "ok" },
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 1 }],
          cause: "spoilage",
          confidence: 0.9,
        }),
        { text: "ok" },
      ]);
      const handle = handler(model, new RecordingObserver());
      const first = await handle(photoMessage(), io);
      expect(editOf(await handle(tap(button(first, "Batal")))).text).toBe("Dibatalkan.");
      expect(await handle(tap(button(first, "Simpan")))).toEqual({
        type: "reply",
        text: ALREADY_CANCELLED_TEXT,
        edits: [],
      });

      const second = await handle(photoMessage(), io);
      clock = new Date(clock.getTime() + 31 * 60 * 1000);
      expect(asReply(await handle(tap(button(second, "Simpan")))).text).toBe(EXPIRED_TEXT);
      expect(photos.saved).toHaveLength(0);
      expect(scorer.scores).toHaveLength(0);
    });

    it("refuses a tap from anyone but the user who sent the photo", async () => {
      const model = new ScriptedModel([
        propose({
          lines: [{ item_id: ids.nasi, portion_count: 1 }],
          cause: "spoilage",
          confidence: 0.9,
        }),
        { text: "ok" },
      ]);
      const handle = handler(model, new RecordingObserver());
      const card = await handle(photoMessage(), io);
      const other = asReply(await handle(tap(button(card, "Simpan"), TELEGRAM_A2)));
      expect(other.text).toBe(NOT_YOURS_TEXT);
      expect(photos.saved).toHaveLength(0);
    });

    it("does not guess an item that is not on the outlet's menu", async () => {
      const model = new ScriptedModel([
        propose({ lines: [{ item_id: ids.soto, portion_count: 1 }] }),
        { text: "Soto tidak ada di menu outlet ini." },
      ]);
      const result = asReply(
        await handler(model, new RecordingObserver())(message("soto 1 porsi basi")),
      );
      expect(model.lastToolResult()).toContain("not on this outlet's menu");
      expect(result).toEqual({ type: "reply", text: "Soto tidak ada di menu outlet ini." });
    });

    it("refuses a guess whose portions would weigh more than an entry can hold", async () => {
      await db.insert(menuItems).values({
        id: "00000000-0000-4000-8000-00000000010a",
        outletId: ids.outletA,
        name: "Tumpeng Besar",
        category: "main",
        costPerPortion: "500000",
        portionWeightKg: "15.000",
        foodCategory: "rice",
      });
      const model = new ScriptedModel([
        propose({
          lines: [{ item_id: "00000000-0000-4000-8000-00000000010a", portion_count: 10000 }],
        }),
        { text: "Jumlahnya terlalu besar." },
      ]);
      const result = await handler(model, new RecordingObserver())(message("tumpeng 10000 porsi"));
      expect(model.lastToolResult()).toContain("more than");
      expect(result).toEqual({ type: "reply", text: "Jumlahnya terlalu besar." });
    });

    it("answers other attachments with a fixed reply, without the model", async () => {
      const model = new ScriptedModel([]);
      const base = message("") as Extract<ChannelEvent, { type: "message" }>;
      const voice: ChannelEvent = {
        ...base,
        attachments: [{ id: "v-1", type: "audio", mediaType: "audio/ogg" }],
      };
      expect(await handler(model, new RecordingObserver())(voice, io)).toEqual({
        type: "reply",
        text: UNSUPPORTED_ATTACHMENT,
      });
      expect(model.requests).toHaveLength(0);
    });

    it("finds a saved entry with list_entries, then corrects it with update_entry", async () => {
      const model = new ScriptedModel([
        {
          toolCall: {
            name: "list_entries",
            input: { from: "2026-03-02", to: "2026-03-02", item_id: ids.rendang },
          },
        },
        {
          toolCall: {
            name: "update_entry",
            input: { id: ids.wasteRendangDay2, patch: { cause: "spoilage" } },
          },
        },
        { text: "Sudah diperbaiki: penyebabnya basi." },
      ]);
      await handler(
        model,
        new RecordingObserver(),
      )(message("rendang tanggal 2 itu basi, bukan sisa piring"));
      // The listing gave the model the entry id it then corrected, for the sender's outlet only.
      const listing = JSON.stringify(model.requests[1]!.chatHistory.at(-1));
      expect(listing).toContain(ids.wasteRendangDay2);
      expect(listing).not.toContain(ids.wasteRendangDay1);
      const [entry] = await db
        .select()
        .from(wasteEntries)
        .where(eq(wasteEntries.id, ids.wasteRendangDay2));
      expect(entry!.cause).toBe("spoilage");
    });

    it("scores a later correction on the trace of the turn that logged the entry", async () => {
      const [run] = await db
        .insert(agentRuns)
        .values({
          agent: "copilot",
          trigger: "telegram",
          status: "succeeded",
          traceId: "trace-logged",
        })
        .returning();
      const [entry] = await db
        .insert(wasteEntries)
        .values({
          outletId: ids.outletA,
          itemId: ids.nasi,
          weightKg: "0.600",
          portionCount: 3,
          cause: "over_prep",
          source: "text",
          confirmedBy: ids.staffA,
          runId: run!.id,
          loggedAt: new Date("2026-03-02T12:00:00Z"),
        })
        .returning();
      const model = new ScriptedModel([
        {
          toolCall: { name: "update_entry", input: { id: entry!.id, patch: { portion_count: 5 } } },
        },
        { text: "Sudah diperbaiki." },
      ]);
      await handler(model, new RecordingObserver())(message("kemarin nasinya 5 porsi, bukan 3"));
      expect(scorer.scores).toEqual([
        {
          traceId: "trace-logged",
          name: "waste_entry_corrected",
          value: 1,
          metadata: { fields: ["portion_count", "weight_kg"], user_id: ids.staffA },
        },
      ]);
    });
  });
});
