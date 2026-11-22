import { sendChannelMessage, type ChannelAddress, type ChannelEvent } from "@anvia/channel";
import { telegram } from "@anvia/telegram";
import type { TurnResult } from "./turn";

/**
 * Thin adapter: Telegram in polling mode (ADR 0012), every event handed to the turn handler.
 * Turns are serialised per conversation so chat history stays in order.
 */
export function createTelegramService(options: {
  token: string;
  handleTurn: (event: ChannelEvent) => Promise<TurnResult>;
  log?: (message: string, error?: unknown) => void;
}) {
  const log = options.log ?? ((message, error) => console.error(message, error ?? ""));
  const channel = telegram({
    token: options.token,
    onError: (error, context) => log(`Telegram ${context.operation} error`, error),
  });
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
    const result = await options.handleTurn(event);
    if (result.type === "reply") {
      await sendChannelMessage({ channel, address, message: { text: result.text } });
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
