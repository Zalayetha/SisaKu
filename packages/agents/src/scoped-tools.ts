import type { AnyTool, JsonObject, JsonValue, ToolCallContext, ToolDefinition } from "@anvia/core";
import type { McpServer } from "@anvia/core/mcp";

/**
 * Who the agent acts for. Comes from the user lookup or the pipeline run, never from the model.
 * A nightly pipeline step acts for an outlet with no user, and gets read-only tools only.
 */
export type ToolScope = {
  readonly outletId: string;
  readonly userId?: string;
};

/**
 * Arguments the model must never choose. They are removed from the schema the model sees and
 * filled in from the scope on every call, overwriting anything the model sent. They may sit at
 * the top level (`get_sales`) or inside a nested object (`query_waste.filters`).
 */
const INJECTED = {
  outlet_id: (scope: ToolScope) => scope.outletId,
  confirmed_by: (scope: ToolScope) => scope.userId,
} as const;

/**
 * The only tools an agent with no user may have: they read and change nothing. Deny by default,
 * like the Copilot's allowlist, so a write tool added to a server later is refused until it is
 * added here on purpose.
 */
export const READ_ONLY_TOOLS = [
  "get_menu",
  "get_sales",
  "get_prep_log",
  "list_entries",
  "query_waste",
  "get_factor",
  "compute_co2e",
  "find_foodbanks",
] as const;

const readOnly = new Set<string>(READ_ONLY_TOOLS);

type InjectedName = keyof typeof INJECTED;
type Injection = { path: readonly string[]; name: InjectedName };

const isInjected = (key: string): key is InjectedName => Object.hasOwn(INJECTED, key);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a schema declares injected arguments, following nested object properties. */
function findInjections(schema: JsonObject, path: readonly string[] = []): Injection[] {
  const properties = schema.properties;
  if (!isObject(properties)) return [];
  return Object.entries(properties).flatMap(([key, child]) => {
    if (isInjected(key)) return [{ path, name: key }];
    return isObject(child) ? findInjections(child, [...path, key]) : [];
  });
}

/** The schema without injected arguments, at every level. */
function hideInjected(schema: JsonObject): JsonObject {
  const { properties, required, ...rest } = schema;
  const result: JsonObject = { ...rest };
  if (isObject(properties)) {
    result.properties = Object.fromEntries(
      Object.entries(properties)
        .filter(([key]) => !isInjected(key))
        .map(([key, child]) => [key, isObject(child) ? hideInjected(child) : child]),
    );
  }
  if (Array.isArray(required)) {
    result.required = required.filter((key) => typeof key !== "string" || !isInjected(key));
  }
  return result;
}

function inject(args: unknown, injections: readonly Injection[], scope: ToolScope): JsonObject {
  const input: JsonObject = isObject(args) ? structuredClone(args) : {};
  for (const { path, name } of injections) {
    let target = input;
    for (const key of path) {
      const next = target[key];
      target = target[key] = isObject(next) ? next : {};
    }
    const value = INJECTED[name](scope);
    // Never undefined for a scoped tool (scopedTools refuses it), but the model must not fill it in.
    if (value === undefined) delete target[name];
    else target[name] = value;
  }
  return input;
}

function scopeTool(tool: AnyTool, injections: readonly Injection[], scope: ToolScope): AnyTool {
  return {
    name: tool.name,
    async definition(prompt: string): Promise<ToolDefinition> {
      const definition = await tool.definition(prompt);
      return { ...definition, parameters: hideInjected(definition.parameters) };
    },
    parseInput(args: JsonValue) {
      return tool.parseInput ? tool.parseInput(args) : args;
    },
    async call(args: unknown, context?: ToolCallContext) {
      return tool.call(inject(args, injections, scope), context);
    },
  };
}

/**
 * The tools the model may use for one outlet: only allowlisted MCP tools, with `outlet_id` and
 * `confirmed_by` hidden from their schemas and injected from `scope` on every call. Without a user
 * in the scope, a tool outside `READ_ONLY_TOOLS` is refused here, so it can never be called.
 */
export async function scopedTools(
  servers: readonly McpServer[],
  allowlist: readonly string[],
  scope: ToolScope,
): Promise<AnyTool[]> {
  const allowed = new Set(allowlist);
  const tools = servers
    .flatMap((server) => server.tools)
    .filter((tool) => allowed.has(tool.mcp.remoteName) && allowed.has(tool.name));
  if (scope.userId === undefined) {
    const writer = tools.find((tool) => !readOnly.has(tool.mcp.remoteName));
    if (writer) throw new Error(`${writer.name} is not read-only, and needs a user in its scope`);
  }
  return Promise.all(
    tools.map(async (tool) =>
      scopeTool(tool, findInjections((await tool.definition("")).parameters), scope),
    ),
  );
}
