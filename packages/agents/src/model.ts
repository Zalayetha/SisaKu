import { OpenAIClient } from "@anvia/openai";

/** One model for every agent, so eval results stay comparable (technical design). */
export const DEFAULT_MODEL_ID = "gpt-5.6.luna";

/**
 * The chat model. Reads LLM_API_KEY, and optionally LLM_BASE_URL (an OpenAI-compatible gateway)
 * and LLM_MODEL_ID. Blank values count as unset: `--env-file` loads `LLM_MODEL_ID=` as "".
 */
export function createModel(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is not set");
  const client = new OpenAIClient(
    env.LLM_BASE_URL ? { apiKey, baseUrl: env.LLM_BASE_URL } : { apiKey },
  );
  return client.completionModel({ modelId: env.LLM_MODEL_ID || DEFAULT_MODEL_ID, api: "chat" });
}
