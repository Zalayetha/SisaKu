import {
  sendChannelMessage,
  type Channel,
  type ChannelAddress,
  type ChannelEvent,
} from "@anvia/channel";
import type { TurnIO, TurnResult } from "./turn";

/**
 * Thin adapter: Telegram in polling mode (ADR 0012), every event handed to the turn handler,
 * which may answer with a message (with buttons), a chart photo after it (ADR 0015), and edits of
 * earlier waste cards (ADR 0014). The channel is passed in, so tests can use a fake one.
 * Turns are serialised per conversation so chat history stays in order.
 */
export function createTelegramService(options: {
  channel: Channel;
  handleTurn: (event: ChannelEvent, io: TurnIO) => Promise<TurnResult>;
  log?: (message: string, error?: unknown) => void;
}) {
  const log = options.log ?? ((message, error) => console.error(message, error ?? ""));
  const { channel } = options;
  const queues = new Map<string, Promise<void>>();

  async function handle(event: ChannelEvent) {
    if (event.type === "message-deleted") return;
    const address: ChannelAddress = {
      platform: event.platform,
      ...(event.accountId ? { accountId: event.accountId } : {}),
      conversationId: event.conversation.id,
      ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
    };
    if (event.conversation.kind === "direct") {
      await channel.showTyping?.(address).catch(() => undefined);
    }
    const io: TurnIO = {};
    if (event.type === "message" && channel.loadAttachment) {
      const load = channel.loadAttachment.bind(channel);
      // Events come from this channel, so their raw payload is a Telegram update.
      const raw = event as Parameters<typeof load>[0];
      io.loadAttachment = (attachment) => load(raw, attachment);
    }
    const result = await options.handleTurn(event, io);
    if (result.type === "skip") return;
    // Card edits are best-effort: an old card that cannot be edited must not block the reply.
    for (const edit of result.edits ?? []) {
      await channel
        .edit?.(
          { id: edit.messageId, address },
          { text: edit.text, ...(edit.actions ? { actions: edit.actions } : {}) },
        )
        .catch((error: unknown) => log("Failed to edit a waste card", error));
    }
    if (result.type === "reply") {
      const sent = await sendChannelMessage({
        channel,
        address,
        message: { text: result.text, ...(result.actions ? { actions: result.actions } : {}) },
      });
      const last = sent.at(-1);
      if (last) result.onSent?.(last.id);
      // The chart follows the text; the text is already delivered, so a failure only logs.
      if (result.chart) {
        await sendChannelMessage({
          channel,
          address,
          message: {
            text: "",
            attachments: [
              {
                type: "image",
                mediaType: "image/png",
                filename: "grafik.png",
                size: result.chart.png.byteLength,
                source: { type: "data", data: result.chart.png.toString("base64") },
              },
            ],
          },
        }).catch((error: unknown) => log("Failed to send a chart", error));
      }
    }
  }

  return {
    /** Validates the token with getMe, then polls. */
    async start() {
      await channel.start((event) => {
        const key = event.conversation.id;
        const next = (queues.get(key) ?? Promise.resolve()).then(() => handle(event));
        const settled = next.catch((error) => log("Failed to deliver a Copilot reply", error));
        queues.set(key, settled);
        void settled.then(() => {
          if (queues.get(key) === settled) queues.delete(key);
        });
        return Promise.resolve();
      });
    },
    async stop() {
      await channel.stop();
      await Promise.allSettled(queues.values());
    },
  };
}
