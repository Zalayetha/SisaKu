import { connectInMemoryServers } from "@sisaku/agents/testing";
import { createDb } from "@sisaku/db";
import { createPipelineWorker } from "../worker";
import type { PipelineSteps, StepDefinition } from "../steps";
import { TEST_STEPS } from "./steps";

// Test-only: the pipeline worker as a process to be killed. It prints "start <step>" for every
// attempt, and never finishes the step named in HANG_STEP or, with HANG_FALLBACK, its fallback.

const { HANG_STEP, HANG_FALLBACK, FALLBACK_STEP, REDIS_URL, PIPELINE_REDIS_PREFIX } = process.env;
const { db } = createDb();
const { servers } = await connectInMemoryServers(db);
const hang = () => new Promise<never>(() => {});

function observed(step: StepDefinition): StepDefinition {
  return {
    ...step,
    run: (context) => {
      console.log(`start ${step.name}`);
      return step.name === HANG_STEP ? hang() : step.run(context);
    },
    ...(step.name === FALLBACK_STEP && {
      fallback: async () => {
        console.log(`fallback ${step.name}`);
        return HANG_FALLBACK ? hang() : { stub: true };
      },
    }),
  };
}

createPipelineWorker({
  db,
  servers,
  redis: { url: REDIS_URL!, prefix: PIPELINE_REDIS_PREFIX! },
  steps: Object.fromEntries(
    Object.values(TEST_STEPS).map((step) => [step.name, observed(step)]),
  ) as PipelineSteps,
  stalledAfterMs: 500,
  log: () => undefined,
});
