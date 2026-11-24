import { defineMetric, EvalOutcome } from "@anvia/core/evals";
import { isObject, resolveItems, type ToolCallCase } from "./cases";
import type { ToolCall, TurnOutput } from "./target";

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

const describeCall = (call: ToolCall | undefined) =>
  call ? `${call.name} ${JSON.stringify(call.args)}` : "no tool call";

/**
 * Tool-call correctness: the first tool call is the expected tool, with the expected arguments
 * as a subset (`{item:<name>}` resolved through the eval outlet's menu). `tool: null` passes
 * only when no tool was called.
 */
export function toolCallMetric(menu: ReadonlyMap<string, string>) {
  return defineMetric<ToolCallCase, TurnOutput, boolean, unknown, "tool_call">({
    name: "tool_call",
    evaluate({ case: { input }, output }) {
      const first = output.calls[0];
      const { tool, args } = input.expected;
      const expectedArgs = resolveItems(args ?? {}, menu);
      const pass =
        tool === null
          ? first === undefined
          : first?.name === tool && matchesSubset(expectedArgs, first.args);
      const comment = `expected ${tool === null ? "no tool call" : `${tool} ${JSON.stringify(expectedArgs)}`}, got ${describeCall(first)}`;
      return pass ? EvalOutcome.pass(true, { comment }) : EvalOutcome.fail(false, { comment });
    },
  });
}
