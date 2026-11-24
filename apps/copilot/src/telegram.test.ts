import type {
  Channel,
  ChannelAddress,
  ChannelEvent,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";
import { describe, expect, it } from "vitest";
import { createTelegramService } from "./telegram";
import type { TurnResult } from "./turn";

/** Stands in for Telegram: records what the service sends and edits, and can fail on demand. */
class FakeChannel implements Channel {
  readonly platform = "telegram";
  readonly sent: { conversationId: string; message: ChannelMessage }[] = [];
  readonly edited: { id: string; message: ChannelMessage }[] = [];
  /** Returns an error to make that send fail. */
  failSend: (message: ChannelMessage) => Error | undefined = () => undefined;
  failEdit: (id: string) => Error | undefined = () => undefined;
  #handler?: ChannelEventHandler;

  splitMessage(message: ChannelMessage) {
    return [message];
  }
  async start(handler: ChannelEventHandler) {
    this.#handler = handler;
  }
  async stop() {}
  async send(address: ChannelAddress, message: ChannelMessage): Promise<SentChannelMessage> {
    const error = this.failSend(message);
    if (error) throw error;
    this.sent.push({ conversationId: address.conversationId, message });
    return { id: `sent-${this.sent.length}`, address };
  }
  async edit(sent: SentChannelMessage, message: ChannelMessage) {
    const error = this.failEdit(sent.id);
    if (error) throw error;
    this.edited.push({ id: sent.id, message });
  }
  async showTyping() {}

  emit(event: ChannelEvent) {
    return this.#handler!(event);
  }
  texts() {
    return this.sent.map((s) => s.message.text);
  }
}

function message(text: string, chat = "chat-1"): ChannelEvent {
  return {
    type: "message",
    id: `m-${text}`,
    platform: "telegram",
    conversation: { id: chat, kind: "direct" },
    sender: { id: "1001", displayName: "Budi", bot: false },
    text,
    attachments: [],
    mentionedBot: false,
    raw: {},
  };
}

/** Starts a service over a fake channel, feeds it events, and waits until every turn is done. */
async function run(
  results: (event: ChannelEvent) => TurnResult | Promise<TurnResult>,
  events: ChannelEvent[],
  channel = new FakeChannel(),
) {
  const logs: string[] = [];
  const service = createTelegramService({
    channel,
    handleTurn: async (event) => results(event),
    log: (m) => logs.push(m),
  });
  await service.start();
  for (const event of events) await channel.emit(event);
  await service.stop();
  return { channel, logs };
}

describe("Telegram service", () => {
  it("sends a reply with its buttons and reports the sent message id", async () => {
    let sentId: string | undefined;
    const { channel } = await run(
      () => ({
        type: "reply",
        text: "Limbah yang dicatat",
        actions: [{ id: "w:x:s", label: "Simpan" }],
        onSent: (id) => (sentId = id),
      }),
      [message("nasi 3 porsi")],
    );
    expect(channel.sent).toEqual([
      {
        conversationId: "chat-1",
        message: { text: "Limbah yang dicatat", actions: [{ id: "w:x:s", label: "Simpan" }] },
      },
    ]);
    expect(sentId).toBe("sent-1");
  });

  it("edits an older card before replying, and still replies when that edit fails", async () => {
    const channel = new FakeChannel();
    channel.failEdit = (id) =>
      id === "card-2" ? new Error("message to edit not found") : undefined;
    const { logs } = await run(
      (event) => ({
        type: "reply",
        text: `balasan ${event.type === "message" ? event.text : ""}`,
        edits: [
          {
            messageId: event.type === "message" && event.text === "a" ? "card-1" : "card-2",
            text: "Diganti.",
          },
        ],
      }),
      [message("a"), message("b")],
      channel,
    );
    expect(channel.edited).toEqual([{ id: "card-1", message: { text: "Diganti." } }]);
    expect(channel.texts()).toEqual(["balasan a", "balasan b"]);
    expect(logs).toEqual(["Failed to edit a waste card"]);
  });

  it("sends a chart after its text, and only logs when the chart fails", async () => {
    const channel = new FakeChannel();
    channel.failSend = (m) =>
      m.attachments?.length && channel.sent.length > 1 ? new Error("photo too big") : undefined;
    const chart = { png: Buffer.from("png"), title: "Limbah" };
    const { logs } = await run(
      () => ({ type: "reply", text: "Tren limbah", chart }),
      [message("tren"), message("tren lagi")],
      channel,
    );
    expect(channel.texts()).toEqual(["Tren limbah", "", "Tren limbah"]);
    expect(channel.sent[1]!.message.attachments?.[0]).toMatchObject({
      type: "image",
      mediaType: "image/png",
    });
    expect(logs).toEqual(["Failed to send a chart"]);
  });

  it("handles one conversation's turns in order, even when an earlier turn is slower", async () => {
    const { channel } = await run(
      async (event) => {
        const text = event.type === "message" ? event.text : "";
        if (text === "pertama") await new Promise((r) => setTimeout(r, 20));
        return { type: "reply", text };
      },
      [message("pertama"), message("kedua")],
    );
    expect(channel.texts()).toEqual(["pertama", "kedua"]);
  });

  it("sends nothing for a skipped turn", async () => {
    const { channel } = await run(() => ({ type: "skip" }), [message("halo")]);
    expect(channel.sent).toEqual([]);
  });
});
