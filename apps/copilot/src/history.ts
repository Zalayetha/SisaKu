import type { Message } from "@anvia/core";

/**
 * Recent chat per conversation, in memory only (ADR 0012): lost on restart. Keeps the user's
 * messages and the Copilot's final replies, plus Simpan / Batal / Ubah taps as pairs (ADR 0014),
 * not tool calls, capped at `maxMessages`. Written only once a reply has been delivered.
 */
export class ChatHistory {
  readonly #conversations = new Map<string, Message[]>();

  constructor(readonly maxMessages = 20) {}

  get(key: string): readonly Message[] {
    return this.#conversations.get(key) ?? [];
  }

  append(key: string, userText: string, replyText: string): void {
    const next: Message[] = [
      ...this.get(key),
      { role: "user", content: userText },
      { role: "assistant", content: replyText },
    ];
    this.#conversations.set(key, next.slice(-this.maxMessages));
  }
}
