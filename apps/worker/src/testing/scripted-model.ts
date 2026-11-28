import {
  Usage,
  type CompletionModel,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
} from "@anvia/core";

// Test-only: a model that answers from a script and records every request it gets.

export type ScriptedAnswer =
  | { toolCall: { name: string; input: JsonValue } }
  | { text: string }
  | { error: Error };

export class ScriptedModel implements CompletionModel {
  readonly provider = "stub";
  readonly modelId = "scripted";
  readonly capabilities = {
    streaming: false,
    tools: true,
    toolChoice: true,
    imageInput: false,
    documentInput: false,
    outputSchema: false,
    reasoning: false,
  };
  readonly requests: CompletionRequest[] = [];

  /** `answer` is called with each request, and how many came before it. */
  constructor(private readonly answer: (request: CompletionRequest, n: number) => ScriptedAnswer) {}

  /** Gives the answers in order, then fails. */
  static of(answers: ScriptedAnswer[]) {
    return new ScriptedModel(() => answers.shift() ?? { error: new Error("Out of answers") });
  }

  async completion(request: CompletionRequest): Promise<CompletionResponse> {
    const n = this.requests.length;
    this.requests.push(structuredClone(request));
    const answer = this.answer(request, n);
    if ("error" in answer) throw answer.error;
    const base = { usage: Usage.empty(), rawResponse: {} };
    if ("text" in answer) {
      return { ...base, choice: [{ type: "text", text: answer.text }], finishReason: "stop" };
    }
    return {
      ...base,
      choice: [
        {
          type: "tool-call",
          toolCallId: `call-${n + 1}`,
          toolName: answer.toolCall.name,
          input: answer.toolCall.input,
        },
      ],
      finishReason: "tool-calls",
    };
  }

  /** The first request of each agent run: no answer of the model's is in its history yet. */
  get runs(): CompletionRequest[] {
    return this.requests.filter((request) =>
      request.chatHistory.every((message) => message.role === "user"),
    );
  }
}

/** A model answer giving an explanation, as the investigator is told to write one. */
export const explain = (kind: string, evidence?: string): ScriptedAnswer => ({
  text: JSON.stringify(evidence === undefined ? { kind } : { kind, evidence }),
});
