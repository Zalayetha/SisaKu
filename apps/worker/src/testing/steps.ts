import { Usage, type CompletionModel } from "@anvia/core";
import { createForecastStep } from "../forecast";
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

/** Test-only stub model for Forecast when non-Forecast tests run on a holiday or Ramadan date. */
export const NO_ADJUSTMENTS_MODEL: CompletionModel = {
  ...NO_MODEL,
  modelId: "stub-no-adjustments",
  completion: async () => ({
    usage: Usage.empty(),
    rawResponse: {},
    choice: [{ type: "text", text: '{"adjustments":[]}' }],
    finishReason: "stop",
  }),
};

export const TEST_STEPS = {
  ...defaultSteps({ model: NO_MODEL }),
  forecast: createForecastStep({ model: NO_ADJUSTMENTS_MODEL }),
};
