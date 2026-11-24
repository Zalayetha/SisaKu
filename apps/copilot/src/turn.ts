import type {
  ChannelAction,
  ChannelActionEvent,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelEvent,
} from "@anvia/channel";
import type { CompletionModel, UserContentPart } from "@anvia/core";
import type { AgentObserver } from "@anvia/core/observability";
import type { McpServer } from "@anvia/core/mcp";
import {
  callMcpTool,
  COPILOT_INSTRUCTIONS_VERSION,
  COPILOT_TOOL_ALLOWLIST,
  createCopilotAgent,
  scopedTools,
} from "@sisaku/agents";
import { createChartTool, type ChartContext } from "./charts/chart-tool";
import type { ChartRenderer } from "./charts/render";
import type { ChatHistory } from "./history";
import type { CopilotUser, Db, UserLookup } from "./users";
import { handleWasteAction } from "./waste/actions";
import { describeForModel, parseActionId, renderCard } from "./waste/card";
import { withCorrectionFeedback, type FeedbackScorer } from "./waste/feedback";
import { GuessStore, type MenuItem } from "./waste/guess";
import type { PhotoStore } from "./waste/photos";
import { createProposeWasteTool, type ProposeContext } from "./waste/propose-tool";

/** An edit of a card the bot sent earlier, by its message id. */
export type CardEdit = { messageId: string; text: string; actions?: readonly ChannelAction[] };

export type TurnResult =
  | { type: "skip" }
  | {
      type: "reply";
      text: string;
      actions?: readonly ChannelAction[];
      /** A chart to send as a photo after the text; its title is drawn on it (ADR 0015). */
      chart?: { png: Buffer; title: string };
      edits?: readonly CardEdit[];
      /**
       * Called once the message reached the user, with its id, so a card can be edited later.
       * Chat history is written here, so the model only remembers what the user received.
       */
      onDelivered?: (messageId?: string) => void;
      /** Called when the message could not be delivered: a card nobody saw must not be saveable. */
      onFailed?: () => void;
    }
  | {
      type: "edit";
      edits: readonly CardEdit[];
      /** Called once the edit (or the card resent in its place) reached the user. */
      onDelivered?: (messageId?: string) => void;
    };

/** What the channel offers a turn beyond the event itself. */
export type TurnIO = {
  loadAttachment?: (attachment: ChannelAttachment) => Promise<ChannelAttachmentData>;
};

export const APOLOGY = "Maaf, ada kendala. Coba lagi sebentar lagi.";
export const UNSUPPORTED_ATTACHMENT = "Kirim foto atau teks saja.";
export const PHOTO_TOO_LARGE =
  "Fotonya terlalu besar (maksimal 10 MB). Kirim foto yang lebih kecil.";
export const REPLACED_CARD_TEXT = "Diganti dengan draft baru di bawah.";
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function unregisteredReply(telegramUserId: string): string {
  return (
    `Akun Telegram kamu belum terdaftar di SisaKu. Minta manajer outlet untuk menambahkan ` +
    `Telegram ID kamu: ${telegramUserId}\n\n` +
    `Your Telegram account isn't registered with SisaKu yet. Ask your outlet manager to add ` +
    `your Telegram ID: ${telegramUserId}`
  );
}

export type TurnDeps = {
  lookupUser: UserLookup;
  db: Db;
  servers: readonly McpServer[];
  model: CompletionModel;
  observer: AgentObserver;
  history: ChatHistory;
  photos: PhotoStore;
  /** Lens in production; a recording fake in tests. */
  scorer: FeedbackScorer;
  /** Vega-Lite + resvg in production; a recording fake in tests. */
  charts: ChartRenderer;
  guesses?: GuessStore;
  allowlist?: readonly string[];
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

/** Calendar date (YYYY-MM-DD) in a time zone. */
function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

class PhotoTooLarge extends Error {}

async function loadPhoto(
  attachment: ChannelAttachment,
  io: TurnIO,
): Promise<{ data: Buffer; mediaType: string }> {
  if (attachment.size !== undefined && attachment.size > MAX_PHOTO_BYTES) throw new PhotoTooLarge();
  if (!io.loadAttachment) throw new Error("This channel cannot load attachments");
  const source = await io.loadAttachment(attachment);
  const data =
    source.type === "data"
      ? Buffer.from(source.data, "base64")
      : Buffer.from(await (await fetch(source.url)).arrayBuffer());
  if (data.byteLength > MAX_PHOTO_BYTES) throw new PhotoTooLarge();
  return { data, mediaType: attachment.mediaType };
}

/**
 * One chat turn: the only seam between Telegram and the Copilot. Direct messages only;
 * unknown senders get a fixed reply without a model call; messages run the agent with tools
 * scoped to the sender's outlet and one Lens trace; taps on waste cards are handled by fixed
 * code (ADR 0014).
 */
export function createTurnHandler(deps: TurnDeps) {
  const allowlist = deps.allowlist ?? COPILOT_TOOL_ALLOWLIST;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));
  const guesses = deps.guesses ?? new GuessStore(now);
  const wasteDeps = { ...deps, store: guesses, log };

  async function loadMenu(outletId: string): Promise<MenuItem[]> {
    const menu = await callMcpTool<{
      items: { id: string; name: string; portion_weight_kg: number }[];
    }>(deps.servers, "get_menu", { outlet_id: outletId });
    return menu.items.map((i) => ({
      id: i.id,
      name: i.name,
      portionWeightKg: i.portion_weight_kg,
    }));
  }

  async function handleAction(event: ChannelActionEvent): Promise<TurnResult> {
    const parsed = parseActionId(event.actionId);
    if (!parsed) return { type: "skip" };
    try {
      const user = await deps.lookupUser(event.sender.id);
      if (!user) return { type: "reply", text: unregisteredReply(event.sender.id) };
      const outcome = await handleWasteAction(
        {
          ...parsed,
          userId: user.id,
          messageId: event.messageId,
          today: localDate(now(), user.timezone),
        },
        wasteDeps,
      );
      const edits = outcome.edit ? [{ messageId: event.messageId, ...outcome.edit }] : [];
      const { history } = outcome;
      const remember = history
        ? () => deps.history.append(event.conversation.id, history.user, history.assistant)
        : undefined;
      if (outcome.reply) {
        const reply = { type: "reply" as const, text: outcome.reply, edits };
        return remember ? { ...reply, onDelivered: remember } : reply;
      }
      if (edits.length === 0) return { type: "skip" };
      return {
        type: "edit",
        edits,
        onDelivered: (messageId) => {
          // A card that could not be edited was resent: later edits must go to the new one.
          const guess = messageId ? guesses.get(parsed.guessId) : undefined;
          if (guess) guess.cardMessageId = messageId;
          remember?.();
        },
      };
    } catch (error) {
      log("Waste card action failed", error);
      return { type: "reply", text: APOLOGY };
    }
  }

  async function handleMessage(
    event: ChannelEvent,
    text: string,
    attachments: readonly ChannelAttachment[],
    user: CopilotUser,
    io: TurnIO,
  ): Promise<TurnResult> {
    if (attachments.some((a) => a.type !== "image")) {
      return { type: "reply", text: UNSUPPORTED_ATTACHMENT };
    }
    const photo = attachments[0] ? await loadPhoto(attachments[0], io) : undefined;
    const chatId = event.conversation.id;
    const messageTime = now();
    const today = localDate(messageTime, user.timezone);

    // One menu read per turn: it goes into the instructions and backs propose_waste_entry.
    const menu = await loadMenu(user.outletId);
    const turn: ProposeContext["turn"] = {};
    const chartTurn: ChartContext["turn"] = {};
    const outlet = { outlet_id: user.outletId };
    const open = photo ? undefined : guesses.openIn(chatId);
    const tools = [
      ...scopedTools(deps.servers, allowlist, { outletId: user.outletId, userId: user.id }).map(
        (tool) =>
          tool.name === "update_entry"
            ? withCorrectionFeedback(tool, {
                db: deps.db,
                scorer: deps.scorer,
                userId: user.id,
                log,
              })
            : tool,
      ),
      createProposeWasteTool({
        user,
        chatId,
        messageTime,
        photo,
        store: guesses,
        menu,
        turn,
      }),
      createChartTool({
        menu,
        queryWaste: (args) =>
          callMcpTool(deps.servers, "query_waste", {
            ...args,
            filters: { ...args.filters, ...outlet },
          }),
        getSales: (args) => callMcpTool(deps.servers, "get_sales", { ...args, ...outlet }),
        renderer: deps.charts,
        log,
        turn: chartTurn,
      }),
    ];

    const agent = createCopilotAgent({
      model: deps.model,
      tools,
      observer: deps.observer,
      onObserverError: (error) => log("Lens observer failed", error),
      role: user.role,
      today,
      timezone: user.timezone,
      menu: menu.map(({ id, name }) => ({ id, name })),
      openWasteGuess: open && open.userId === user.id ? describeForModel(open) : undefined,
    });

    const content: string | UserContentPart[] = photo
      ? [
          { type: "text", text: text || "(foto tanpa keterangan)" },
          {
            type: "image",
            image: { type: "data", data: photo.data.toString("base64") },
            mediaType: photo.mediaType,
          },
        ]
      : text;
    const historyKey = chatId;
    let shown = false;
    try {
      const result = await agent.generate({
        messages: [...deps.history.get(historyKey), { role: "user", content }],
        trace: {
          name: "copilot-turn",
          userId: user.id,
          sessionId: `telegram:${chatId}`,
          tags: ["copilot", "telegram"],
          metadata: {
            agent: "copilot",
            outlet_id: user.outletId,
            user_id: user.id,
            role: user.role,
            chat_id: chatId,
            instructions_version: COPILOT_INSTRUCTIONS_VERSION,
          },
        },
      });

      const historyText = photo ? `[foto] ${text}`.trim() : text;
      if (result.type === "response" && turn.guess) {
        const guess = turn.guess;
        shown = true;
        guess.traceId = result.trace?.traceId;
        const card = renderCard(guess, today);
        const replacedId = turn.replaced?.cardMessageId;
        return {
          type: "reply",
          text: card.text,
          ...(card.actions ? { actions: card.actions } : {}),
          edits: replacedId ? [{ messageId: replacedId, text: REPLACED_CARD_TEXT }] : [],
          onDelivered: (messageId) => {
            if (messageId) guess.cardMessageId = messageId;
            deps.history.append(historyKey, historyText, card.text);
          },
          // Like a failed turn: the guess this card would have replaced stays open.
          onFailed: () => {
            guesses.delete(guess.id);
            if (turn.replaced) guesses.add(turn.replaced);
          },
        };
      }
      const reply = result.text.trim();
      if (result.type !== "response" || !reply) return { type: "reply", text: APOLOGY };
      return {
        type: "reply",
        text: reply,
        ...(chartTurn.chart ? { chart: chartTurn.chart } : {}),
        onDelivered: () => deps.history.append(historyKey, historyText, reply),
      };
    } finally {
      // A guess from a failed turn is never shown, so it must not stay saveable; the guess it
      // would have replaced stays open instead.
      if (turn.guess && !shown) {
        guesses.delete(turn.guess.id);
        if (turn.replaced) guesses.add(turn.replaced);
      }
    }
  }

  return async function handleTurn(event: ChannelEvent, io: TurnIO = {}): Promise<TurnResult> {
    if (event.type === "message-deleted") return { type: "skip" };
    if (event.conversation.kind !== "direct" || event.sender.bot) return { type: "skip" };
    if (event.type === "action") return handleAction(event);
    if (event.type !== "message" && event.type !== "command") return { type: "skip" };
    const text = event.type === "command" ? `/${event.name} ${event.text}`.trim() : event.text;
    const attachments = event.type === "message" ? event.attachments : [];
    if (!text.trim() && attachments.length === 0) return { type: "skip" };

    try {
      const user = await deps.lookupUser(event.sender.id);
      if (!user) return { type: "reply", text: unregisteredReply(event.sender.id) };
      return await handleMessage(event, text, attachments, user, io);
    } catch (error) {
      if (error instanceof PhotoTooLarge) return { type: "reply", text: PHOTO_TOO_LARGE };
      // The agent has already recorded the failure on the trace; keep details out of the chat.
      log("Copilot turn failed", error);
      return { type: "reply", text: APOLOGY };
    }
  };
}
