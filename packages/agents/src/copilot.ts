import { Agent, type AnyTool, type CompletionModel } from "@anvia/core";
import type { AgentObserver } from "@anvia/core/observability";
import { COPILOT_INSTRUCTIONS, copilotTurnContext, type CopilotRole } from "./instructions";

export const COPILOT_AGENT_ID = "kitchen-copilot";

export type CopilotAgentOptions = {
  model: CompletionModel;
  tools: readonly AnyTool[];
  /** Anvia Lens in production; a recording fake in tests. */
  observer: AgentObserver;
  onObserverError?: (error: unknown) => void;
  role: CopilotRole;
  today: string;
  timezone: string;
  openWasteGuess?: string | undefined;
  maxTurns?: number;
};

/**
 * One Copilot agent for one chat turn. Built per turn because its tools are scoped to the
 * sender's outlet. Observer failures are ignored, so a Lens outage never blocks a reply.
 */
export function createCopilotAgent(options: CopilotAgentOptions) {
  return new Agent({
    id: COPILOT_AGENT_ID,
    name: "Kitchen Copilot",
    model: options.model,
    instructions: `${COPILOT_INSTRUCTIONS}\n\n${copilotTurnContext(options)}`,
    tools: options.tools,
    maxTurns: options.maxTurns ?? 8,
    observability: {
      observers: { lens: options.observer },
      primaryTrace: "lens",
      errorPolicy: "ignore",
      onObserverError: (failure) => options.onObserverError?.(failure.error),
    },
  });
}
