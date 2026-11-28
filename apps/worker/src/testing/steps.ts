import type { CompletionModel } from "@anvia/core";
import { defaultSteps } from "../steps";

// Test-only: the pipeline's own steps, with a model that refuses every request. A test that
// reaches the model passes a scripted one instead.

export const NO_MODEL: CompletionModel = {
  provider: "stub",
  modelId: "none",
  capabilities: {
    streaming: false,
    tools: true,
    toolChoice: false,
    imageInput: false,
    documentInput: false,
    outputSchema: false,
    reasoning: false,
  },
  completion: () => Promise.reject(new Error("This test has no model")),
};

export const TEST_STEPS = defaultSteps({ model: NO_MODEL });
