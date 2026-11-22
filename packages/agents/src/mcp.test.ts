import { describe, expect, it } from "vitest";
import { mcpSsrfProtection, mcpTransport } from "./mcp";

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
