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
  COPILOT_TOOL_ALLOWLIST,
  createCopilotAgent,
  scopedTools,
} from "@sisaku/agents";
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
      edits?: readonly CardEdit[];
      /** Called with the id of the sent message, so a card can be edited later. */
      onSent?: (messageId: string) => void;
    }
  | { type: "edit"; edits: readonly CardEdit[] };

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
      if (outcome.reply) return { type: "reply", text: outcome.reply, edits };
      return edits.length > 0 ? { type: "edit", edits } : { type: "skip" };
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

    const turn: ProposeContext["turn"] = {};
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
        loadMenu: () => loadMenu(user.outletId),
        turn,
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
          },
        },
      });

      const historyText = photo ? `[foto] ${text}`.trim() : text;
      if (result.type === "response" && turn.guess) {
        const guess = turn.guess;
        shown = true;
        guess.traceId = result.trace?.traceId;
        const card = renderCard(guess, today);
        deps.history.append(historyKey, historyText, card.text);
        const replacedId = turn.replaced?.cardMessageId;
        return {
          type: "reply",
          text: card.text,
          ...(card.actions ? { actions: card.actions } : {}),
          edits: replacedId ? [{ messageId: replacedId, text: REPLACED_CARD_TEXT }] : [],
          onSent: (messageId) => {
            guess.cardMessageId = messageId;
          },
        };
      }
      const reply = result.text.trim();
      if (result.type !== "response" || !reply) return { type: "reply", text: APOLOGY };
      deps.history.append(historyKey, historyText, reply);
      return { type: "reply", text: reply };
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
