import type { CopilotRole } from "@sisaku/agents";
import { readFileSync } from "node:fs";

/** A tool-call correctness case (ADR 0015): the expected first tool call for one message. */
export type ToolCallCase = {
  id: string;
  area: string;
  message: string;
  language: "id" | "en";
  role: CopilotRole;
  today: string;
  /** Earlier chat, oldest first, sent before `message` as the Copilot's chat history would be. */
  history?: { role: "user" | "assistant"; content: string }[];
  expected: { tool: string | null; args?: Record<string, unknown> };
};

export type ToolCallDataset = { outlet: string; cases: ToolCallCase[] };

export function loadToolCallDataset(): ToolCallDataset {
  return JSON.parse(
    readFileSync(new URL("./tool-call/questions.json", import.meta.url), "utf8"),
  ) as ToolCallDataset;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Replaces "{item:<menu name>}" with the item's id in the eval outlet's menu (name → id). */
export function resolveItems(value: unknown, menu: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    const match = /^\{item:(.+)\}$/.exec(value);
    if (!match) return value;
    const id = menu.get(match[1]!);
    if (!id) throw new Error(`${match[1]} is not on the eval outlet's menu`);
    return id;
  }
  if (Array.isArray(value)) return value.map((v) => resolveItems(v, menu));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveItems(v, menu)]));
  }
  return value;
}
