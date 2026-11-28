import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@anvia/core/mcp";
import { McpClient, McpClientGroup, type McpClientTransport } from "@anvia/mcp";

const require = createRequire(import.meta.url);

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
 * Transport for the optional Open-Meteo MCP server (ADR 0019): Streamable HTTP when
 * `WEATHER_MCP_URL` is set (with optional `WEATHER_MCP_TOKEN`), otherwise spawns the installed
 * `open-meteo-mcp-server` package over stdio.
 */
export function weatherMcpTransport(env: NodeJS.ProcessEnv = process.env): McpClientTransport {
  const url = env.WEATHER_MCP_URL;
  if (url) {
    const token = env.WEATHER_MCP_TOKEN;
    return {
      type: "streamableHttp",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ssrfProtection: mcpSsrfProtection(env),
    };
  }
  return {
    type: "stdio",
    command: process.execPath,
    args: [require.resolve("open-meteo-mcp-server")],
    env: definedEnv(env),
    stderr: "inherit",
  };
}

export type WeatherMcpConnection = {
  readonly server: McpServer;
  close(): Promise<void>;
};

/**
 * Connects to the optional Open-Meteo MCP server. Never throws: if the server cannot be reached,
 * logs a warning and returns `undefined` so the worker starts and Forecast runs without weather.
 */
export async function connectWeatherMcp(
  env: NodeJS.ProcessEnv = process.env,
  { log = (message: string, error?: unknown) => console.warn(message, error ?? "") } = {},
): Promise<WeatherMcpConnection | undefined> {
  try {
    const group = await McpClientGroup.connect({
      clients: [
        new McpClient({
          name: "weather",
          transport: weatherMcpTransport(env),
          versionNegotiation: { mode: "auto" },
        }),
      ],
    });
    const server = group.servers[0];
    if (!server) {
      await group.close();
      log("Open-Meteo MCP server connected with no server entry; continuing without weather.");
      return undefined;
    }
    return { server, close: () => group.close() };
  } catch (error) {
    log("Open-Meteo MCP server is unavailable; continuing without weather.", error);
    return undefined;
  }
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
