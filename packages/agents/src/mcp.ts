import { fileURLToPath } from "node:url";
import type { McpServer } from "@anvia/core/mcp";
import { McpClient, McpClientGroup, type McpClientTransport } from "@anvia/mcp";

type ServerConfig = {
  name: "kitchen" | "impact";
  /** Workspace package directory, used for stdio. */
  dir: string;
  urlEnv: string;
  tokenEnv: string;
};

const SERVERS: readonly ServerConfig[] = [
  {
    name: "kitchen",
    dir: fileURLToPath(new URL("../../kitchen-mcp", import.meta.url)),
    urlEnv: "KITCHEN_MCP_URL",
    tokenEnv: "KITCHEN_MCP_TOKEN",
  },
  {
    name: "impact",
    dir: fileURLToPath(new URL("../../impact-mcp", import.meta.url)),
    urlEnv: "IMPACT_MCP_URL",
    tokenEnv: "IMPACT_MCP_TOKEN",
  },
];

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export type McpSsrfProtection = "strict" | "disabled";

/**
 * Whether HTTP MCP connections may reach private addresses, from MCP_SSRF_PROTECTION.
 * Defaults to "strict", which blocks localhost and private ranges. Set "disabled" only when the
 * MCP servers run next to the Copilot on a private network (e.g. Docker service names).
 */
export function mcpSsrfProtection(env: NodeJS.ProcessEnv = process.env): McpSsrfProtection {
  const value = env.MCP_SSRF_PROTECTION || "strict";
  if (value !== "strict" && value !== "disabled") {
    throw new Error(`MCP_SSRF_PROTECTION must be "strict" or "disabled", got "${value}"`);
  }
  return value;
}

/**
 * HTTP with the bearer token when the server's URL is set (deploy, ADR 0009), otherwise the
 * server is spawned over stdio from the workspace (local development).
 */
export function mcpTransport(
  server: Pick<ServerConfig, "dir" | "urlEnv" | "tokenEnv">,
  env: NodeJS.ProcessEnv,
): McpClientTransport {
  const url = env[server.urlEnv];
  if (url) {
    const token = env[server.tokenEnv];
    if (!token) throw new Error(`${server.urlEnv} is set but ${server.tokenEnv} is not`);
    return {
      type: "streamableHttp",
      url,
      headers: { authorization: `Bearer ${token}` },
      ssrfProtection: mcpSsrfProtection(env),
    };
  }
  return {
    type: "stdio",
    command: "pnpm",
    args: ["exec", "tsx", "--env-file-if-exists=../../.env", "src/stdio.ts"],
    cwd: server.dir,
    env: definedEnv(env),
    stderr: "inherit",
  };
}

/** Connects to kitchen-mcp and impact-mcp. Throws if either cannot be reached. */
export function connectMcpServers(env: NodeJS.ProcessEnv = process.env) {
  return McpClientGroup.connect({
    clients: SERVERS.map(
      (server) =>
        new McpClient({
          name: server.name,
          transport: mcpTransport(server, env),
          // Our servers use @modelcontextprotocol/server 2.x, which does not offer the pinned
          // 2026-07-28 revision; allow negotiating down.
          versionNegotiation: { mode: "auto" },
        }),
    ),
  });
}

/**
 * Calls an MCP tool from fixed code (not the model) and returns its JSON result: reads, and tools
 * the model must never call itself, such as `log_waste` (ADR 0014). Throws on a tool error.
 */
export async function callMcpTool<T = unknown>(
  servers: readonly McpServer[],
  remoteName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = servers
    .flatMap((server) => server.tools)
    .find((t) => t.mcp.remoteName === remoteName);
  if (!tool) throw new Error(`MCP tool ${remoteName} is not available`);
  return parseToolJson<T>(await tool.call(args));
}

/**
 * The JSON object in an MCP tool result: `@anvia/mcp` returns rich output whose text content parts
 * hold the server's JSON.
 */
export function parseToolJson<T = unknown>(result: unknown): T {
  const content =
    typeof result === "object" && result !== null && "content" in result ? result.content : result;
  const parts: unknown[] = Array.isArray(content) ? content : [content];
  const text = parts
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
  return JSON.parse(text) as T;
}
