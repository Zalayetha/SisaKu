import { defineMetric, EvalOutcome } from "@anvia/core/evals";
import type { CopilotInput, ExpectedCall } from "./cases";
import type { ToolCall, TurnOutput } from "./target";

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True when every key of `expected` matches `actual`, recursively: objects may have extra keys,
 * arrays must have the same length with each element matching, other values must be equal.
 */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (isObject(expected)) {
    return (
      isObject(actual) &&
      Object.entries(expected).every(([key, value]) => matchesSubset(value, actual[key]))
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => matchesSubset(value, actual[i]))
    );
  }
  return expected === actual;
}

/** `value` without any `outlet_id` key: the turn injects the sender's outlet (ADR 0012). */
function withoutOutletId(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOutletId);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "outlet_id")
      .map(([key, v]) => [key, withoutOutletId(v)]),
  );
}

const describeCall = (call: ToolCall | undefined) =>
  call ? `${call.name} ${JSON.stringify(call.args)}` : "no tool call";

/**
 * Tool-call correctness: the first tool call is the expected tool, with the expected arguments
 * as a subset (`outlet_id` never compared). `tool: null` passes only when no tool was called.
 */
export const toolCallMetric = defineMetric<
  CopilotInput,
  TurnOutput,
  boolean,
  ExpectedCall,
  "tool_call"
>({
  name: "tool_call",
  evaluate({ case: { expected }, output }) {
    if (!expected) return EvalOutcome.invalid("the case has no expected call");
    const first = output.calls[0];
    const { tool, args } = expected;
    const expectedArgs = withoutOutletId(args ?? {});
    const pass =
      tool === null
        ? first === undefined
        : first?.name === tool && matchesSubset(expectedArgs, first.args);
    const comment = `expected ${tool === null ? "no tool call" : `${tool} ${JSON.stringify(expectedArgs)}`}, got ${describeCall(first)}`;
    return pass ? EvalOutcome.pass(true, { comment }) : EvalOutcome.fail(false, { comment });
  },
});
