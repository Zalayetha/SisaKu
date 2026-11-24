import { OpenAIClient } from "@anvia/openai";
import OpenAI from "openai";

/** One model for every agent, so eval results stay comparable (technical design). */
export const DEFAULT_MODEL_ID = "gpt-5.6.luna";

type FinalRequestOptions = Awaited<Parameters<OpenAI["request"]>[0]>;

/**
 * Marks every tool of a chat request `strict: false`. Anvia leaves `strict` out, and a provider
 * that then treats tool schemas as strict makes the model fill optional fields with invented
 * values (#70).
 */
class NonStrictToolsClient extends OpenAI {
  protected override async prepareOptions(options: FinalRequestOptions): Promise<void> {
    await super.prepareOptions(options);
    const body = options.body as { tools?: { type: string; function?: object }[] } | undefined;
    if (!Array.isArray(body?.tools)) return;
    options.body = {
      ...body,
      tools: body.tools.map((tool) =>
        tool.function ? { ...tool, function: { ...tool.function, strict: false } } : tool,
      ),
    };
  }
}

/**
 * The chat model. Reads LLM_API_KEY, and optionally LLM_BASE_URL (an OpenAI-compatible gateway)
 * and LLM_MODEL_ID. Blank values count as unset: `--env-file` loads `LLM_MODEL_ID=` as "".
 */
export function createModel(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is not set");
  const client = new OpenAIClient({
    client: new NonStrictToolsClient({
      apiKey,
      ...(env.LLM_BASE_URL ? { baseURL: env.LLM_BASE_URL } : {}),
      maxRetries: 0, // as in Anvia's own client
    }),
  });
  return client.completionModel({ modelId: env.LLM_MODEL_ID || DEFAULT_MODEL_ID, api: "chat" });
}
