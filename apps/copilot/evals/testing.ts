import {
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
} from "@anvia/core";

export type Answer = { tool: string; input: JsonValue } | { text: string } | { hang: true };

/**
 * Answers by the user's message, so cases can run concurrently: the first request of a turn
 * gets the scripted answer, the request after a tool result gets a short text reply.
 */
export class ByMessageModel implements CompletionModel {
  readonly provider = "stub";
  readonly modelId = "by-message";
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
  constructor(private readonly answers: Record<string, Answer>) {}

  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(request));
    const base = { usage: Usage.empty(), rawResponse: {} };
    const last = request.chatHistory.at(-1);
    if (last?.role === "tool") {
      return { ...base, choice: [{ type: "text", text: "Selesai." }], finishReason: "stop" };
    }
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    const answer = Object.entries(this.answers).find(([message]) => text.includes(message))?.[1];
    if (!answer) throw new Error(`no scripted answer for ${text}`);
    if ("hang" in answer) return new Promise(() => undefined);
    if ("text" in answer) {
      return { ...base, choice: [{ type: "text", text: answer.text }], finishReason: "stop" };
    }
    return {
      ...base,
      choice: [
        {
          type: "tool-call",
          toolCallId: `call-${this.requests.length}`,
          toolName: answer.tool,
          input: answer.input,
        },
      ],
      finishReason: "tool-calls",
    };
  }
}
