import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIClient } from "@anvia/openai";
import { describe, expect, it } from "vitest";
import { createModel, DEFAULT_MODEL_ID } from "./model";

describe("createModel", () => {
  it("uses the default model when LLM_MODEL_ID is blank, as .env.example ships it", () => {
    const model = createModel({ LLM_API_KEY: "k", LLM_MODEL_ID: "", LLM_BASE_URL: "" });
    expect(model.modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("uses LLM_MODEL_ID when set", () => {
    expect(createModel({ LLM_API_KEY: "k", LLM_MODEL_ID: "other-model" }).modelId).toBe(
      "other-model",
    );
  });

  it("refuses to start without LLM_API_KEY", () => {
    expect(() => createModel({ LLM_API_KEY: "" })).toThrow("LLM_API_KEY");
  });

  it("sends strict: false on every tool, and nothing else that Anvia would not send", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(text));
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "1",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [
              { index: 0, message: { role: "assistant", content: "Oke." }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const tool = (name: string) => ({
        name,
        description: name,
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, item_id: { type: "string" } },
          required: ["from"],
        },
      });
      const request = {
        instructions: "Rules",
        chatHistory: [{ role: "user" as const, content: "Halo" }],
        documents: [],
        tools: [tool("get_sales"), tool("query_waste")],
      };
      const ours = createModel({ LLM_API_KEY: "k", LLM_BASE_URL: baseUrl, LLM_MODEL_ID: "m" });
      const anvia = new OpenAIClient({ apiKey: "k", baseUrl }).completionModel({
        modelId: "m",
        api: "chat",
      });
      await ours.completion(request);
      await anvia.completion(request);

      const [sent, plain] = bodies as { tools: { type: string; function: object }[] }[];
      expect(sent!.tools).toHaveLength(2);
      expect(sent).toEqual({
        ...plain,
        tools: plain!.tools.map((t) => ({ ...t, function: { ...t.function, strict: false } })),
      });
    } finally {
      server.close();
    }
  });
});
