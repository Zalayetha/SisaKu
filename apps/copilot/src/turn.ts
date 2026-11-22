import type { ChannelEvent } from "@anvia/channel";
import type { CompletionModel } from "@anvia/core";
import type { AgentObserver } from "@anvia/core/observability";
import type { McpServer } from "@anvia/core/mcp";
import { COPILOT_TOOL_ALLOWLIST, createCopilotAgent, scopedTools } from "@sisaku/agents";
import type { ChatHistory } from "./history";
import type { UserLookup } from "./users";

export type TurnResult = { type: "skip" } | { type: "reply"; text: string };

export const APOLOGY = "Maaf, ada kendala. Coba lagi sebentar lagi.";

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
  servers: readonly McpServer[];
  model: CompletionModel;
  observer: AgentObserver;
  history: ChatHistory;
  allowlist?: readonly string[];
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
};

/** Calendar date (YYYY-MM-DD) in a time zone. */
function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

/**
 * One chat turn: the only seam between Telegram and the Copilot. Direct messages only;
 * unknown senders get a fixed reply without a model call; everything else runs the agent with
 * tools scoped to the sender's outlet and one Lens trace.
 */
export function createTurnHandler(deps: TurnDeps) {
  const allowlist = deps.allowlist ?? COPILOT_TOOL_ALLOWLIST;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, error) => console.error(message, error ?? ""));

  return async function handleTurn(event: ChannelEvent): Promise<TurnResult> {
    if (event.type !== "message" && event.type !== "command") return { type: "skip" };
    if (event.conversation.kind !== "direct" || event.sender.bot) return { type: "skip" };
    const text = event.type === "command" ? `/${event.name} ${event.text}`.trim() : event.text;
    if (!text.trim()) return { type: "skip" };

    try {
      const user = await deps.lookupUser(event.sender.id);
      if (!user) return { type: "reply", text: unregisteredReply(event.sender.id) };

      const agent = createCopilotAgent({
        model: deps.model,
        tools: scopedTools(deps.servers, allowlist, { outletId: user.outletId, userId: user.id }),
        observer: deps.observer,
        onObserverError: (error) => log("Lens observer failed", error),
        role: user.role,
        today: localDate(now(), user.timezone),
        timezone: user.timezone,
      });

      const historyKey = event.conversation.id;
      const result = await agent.generate({
        messages: [...deps.history.get(historyKey), { role: "user", content: text }],
        trace: {
          name: "copilot-turn",
          userId: user.id,
          sessionId: `telegram:${event.conversation.id}`,
          tags: ["copilot", "telegram"],
          metadata: {
            agent: "copilot",
            outlet_id: user.outletId,
            user_id: user.id,
            role: user.role,
            chat_id: event.conversation.id,
          },
        },
      });

      const reply = result.text.trim();
      if (result.type !== "response" || !reply) return { type: "reply", text: APOLOGY };
      deps.history.append(historyKey, text, reply);
      return { type: "reply", text: reply };
    } catch (error) {
      // The agent has already recorded the failure on the trace; keep details out of the chat.
      log("Copilot turn failed", error);
      return { type: "reply", text: APOLOGY };
    }
  };
}
