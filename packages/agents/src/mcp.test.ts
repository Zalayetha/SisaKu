import { describe, expect, it } from "vitest";
import {
  connectWeatherMcp,
  mcpSsrfProtection,
  mcpTransport,
  parseToolJson,
  weatherMcpTransport,
} from "./mcp";

const server = { dir: "/repo/packages/kitchen-mcp", urlEnv: "X_URL", tokenEnv: "X_TOKEN" };

describe("MCP transport", () => {
  it("spawns the server over stdio when no URL is set", () => {
    expect(mcpTransport(server, {})).toMatchObject({ type: "stdio", cwd: server.dir });
  });

  it("uses HTTP with the bearer token and strict SSRF protection by default", () => {
    expect(mcpTransport(server, { X_URL: "https://mcp.example.com/mcp", X_TOKEN: "t" })).toEqual({
      type: "streamableHttp",
      url: "https://mcp.example.com/mcp",
      headers: { authorization: "Bearer t" },
      ssrfProtection: "strict",
    });
  });

  it("allows private addresses only when MCP_SSRF_PROTECTION is disabled", () => {
    const env = {
      X_URL: "http://kitchen-mcp:3001/mcp",
      X_TOKEN: "t",
      MCP_SSRF_PROTECTION: "disabled",
    };
    expect(mcpTransport(server, env)).toMatchObject({ ssrfProtection: "disabled" });
  });

  it("refuses a URL without its token", () => {
    expect(() => mcpTransport(server, { X_URL: "https://mcp.example.com/mcp" })).toThrow("X_TOKEN");
  });

  it("rejects an unknown MCP_SSRF_PROTECTION value", () => {
    expect(() => mcpSsrfProtection({ MCP_SSRF_PROTECTION: "off" })).toThrow("strict");
  });
});

describe("parseToolJson", () => {
  it("reads the JSON text of rich MCP tool output", () => {
    const output = {
      content: [
        { type: "text", text: '{"entry":' },
        { type: "text", text: "1}" },
      ],
    };
    expect(parseToolJson(output)).toEqual({ entry: 1 });
  });
});

describe("weather MCP client", () => {
  it("uses stdio open-meteo-mcp-server when WEATHER_MCP_URL is unset", () => {
    const transport = weatherMcpTransport({});
    expect(transport).toMatchObject({ type: "stdio" });
  });

  it("uses Streamable HTTP when WEATHER_MCP_URL is set, with optional bearer token", () => {
    expect(weatherMcpTransport({ WEATHER_MCP_URL: "https://weather.example.com/mcp" })).toEqual({
      type: "streamableHttp",
      url: "https://weather.example.com/mcp",
      ssrfProtection: "strict",
    });
    expect(
      weatherMcpTransport({
        WEATHER_MCP_URL: "http://weather-mcp:3004/mcp",
        WEATHER_MCP_TOKEN: "secret",
        MCP_SSRF_PROTECTION: "disabled",
      }),
    ).toEqual({
      type: "streamableHttp",
      url: "http://weather-mcp:3004/mcp",
      headers: { authorization: "Bearer secret" },
      ssrfProtection: "disabled",
    });
  });

  it("returns undefined and logs a warning instead of throwing when unreachable", async () => {
    const warnings: string[] = [];
    const client = await connectWeatherMcp(
      {
        WEATHER_MCP_URL: "http://127.0.0.1:1/mcp",
        MCP_SSRF_PROTECTION: "disabled",
      },
      { log: (message) => warnings.push(message) },
    );
    expect(client).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
