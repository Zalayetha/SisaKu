import type {
  Channel,
  ChannelAddress,
  ChannelEvent,
  ChannelEventHandler,
  ChannelMessage,
  SentChannelMessage,
} from "@anvia/channel";
import { describe, expect, it } from "vitest";
import { createTelegramService, DELIVERY_FAILED_TEXT } from "./telegram";
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

/** A tap on a button of the card sent as message "card-1". */
const tap: ChannelEvent = {
  type: "action",
  id: "a-1",
  platform: "telegram",
  conversation: { id: "chat-1", kind: "direct" },
  sender: { id: "1001", displayName: "Budi", bot: false },
  messageId: "card-1",
  actionId: "w:x:c0",
  raw: {},
};

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
  it("sends a reply with its buttons and reports it delivered, with its message id", async () => {
    let sentId: string | undefined;
    const { channel } = await run(
      () => ({
        type: "reply",
        text: "Limbah yang dicatat",
        actions: [{ id: "w:x:s", label: "Simpan" }],
        onDelivered: (id) => (sentId = id),
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

  it("reports a tap's card update delivered once the edit succeeds", async () => {
    const delivered: (string | undefined)[] = [];
    const { channel } = await run(
      () => ({
        type: "edit",
        edits: [{ messageId: "card-1", text: "Dibatalkan." }],
        onDelivered: (id) => delivered.push(id),
      }),
      [tap],
    );
    expect(channel.edited).toEqual([{ id: "card-1", message: { text: "Dibatalkan." } }]);
    expect(delivered).toEqual([undefined]);
  });

  it("resends a tap's card when the channel cannot edit messages at all", async () => {
    const channel = new FakeChannel();
    (channel as { edit?: unknown }).edit = undefined;
    const delivered: (string | undefined)[] = [];
    await run(
      () => ({
        type: "edit",
        edits: [{ messageId: "card-1", text: "Dibatalkan." }],
        onDelivered: (id) => delivered.push(id),
      }),
      [tap],
      channel,
    );
    expect(channel.texts()).toEqual(["Dibatalkan."]);
    expect(delivered).toEqual(["sent-1"]);
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

  describe("when delivery fails (#53)", () => {
    it("tells the user and discards the card's guess when the reply cannot be sent", async () => {
      const channel = new FakeChannel();
      channel.failSend = (m) =>
        m.actions
          ? new RangeError("Channel message must not contain more than 5 actions")
          : undefined;
      let failed = 0;
      let delivered = 0;
      const { logs } = await run(
        () => ({
          type: "reply",
          text: "Penyebabnya apa?",
          actions: [{ id: "w:x:c0", label: "Basi" }],
          onDelivered: () => delivered++,
          onFailed: () => failed++,
        }),
        [message("nasi 3 porsi kebuang")],
        channel,
      );
      expect(failed).toBe(1);
      expect(delivered).toBe(0);
      expect(channel.sent).toEqual([
        { conversationId: "chat-1", message: { text: DELIVERY_FAILED_TEXT } },
      ]);
      expect(logs).toEqual(["Failed to deliver a Copilot reply"]);
    });

    // The tap already changed the guess (a cause chosen, or the entry saved), so the user gets
    // the updated card as a new message, not a "send again" that could log the waste twice.
    it("sends a tap's updated card as a new message when the card cannot be edited", async () => {
      const channel = new FakeChannel();
      channel.failEdit = () => new Error("Bad Request: message can't be edited");
      const actions = [{ id: "w:x:s", label: "Simpan" }];
      const delivered: (string | undefined)[] = [];
      await run(
        () => ({
          type: "edit",
          edits: [{ messageId: "card-1", text: "Limbah yang dicatat", actions }],
          onDelivered: (id) => delivered.push(id),
        }),
        [tap],
        channel,
      );
      expect(channel.sent).toEqual([
        { conversationId: "chat-1", message: { text: "Limbah yang dicatat", actions } },
      ]);
      // The resent card is the one the user now has.
      expect(delivered).toEqual(["sent-1"]);
    });

    it("tells the user when a tap's card can be neither edited nor sent", async () => {
      const channel = new FakeChannel();
      channel.failEdit = () => new Error("Bad Request: message can't be edited");
      channel.failSend = (m) => (m.text === "Tersimpan ✓" ? new Error("network down") : undefined);
      let delivered = 0;
      await run(
        () => ({
          type: "edit",
          edits: [{ messageId: "card-1", text: "Tersimpan ✓" }],
          onDelivered: () => delivered++,
        }),
        [tap],
        channel,
      );
      expect(channel.texts()).toEqual([DELIVERY_FAILED_TEXT]);
      expect(delivered).toBe(0);
    });

    it("only logs when the fallback fails too, and keeps handling later messages", async () => {
      const channel = new FakeChannel();
      let down = true;
      channel.failSend = () => (down ? new Error("network down") : undefined);
      const { logs } = await run(
        (event) => {
          down = event.type === "message" && event.text === "a";
          return { type: "reply", text: "balasan" };
        },
        [message("a"), message("b")],
        channel,
      );
      expect(channel.texts()).toEqual(["balasan"]);
      expect(logs).toEqual([
        "Failed to deliver a Copilot reply",
        "Failed to send the delivery failure notice",
      ]);
    });
  });

  it("sends nothing for a skipped turn", async () => {
    const { channel } = await run(() => ({ type: "skip" }), [message("halo")]);
    expect(channel.sent).toEqual([]);
  });
});
