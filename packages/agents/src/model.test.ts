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
});
