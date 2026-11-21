import { serve } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDb } from "@sisaku/db";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createKitchenServer } from "./server";

// Deployed transport: streamable HTTP on /mcp behind a bearer token. There is no unauthenticated variant.
const token = process.env.KITCHEN_MCP_TOKEN;
if (!token) {
  console.error("KITCHEN_MCP_TOKEN is required to start the kitchen-mcp HTTP server");
  process.exit(1);
}
const port = Number(process.env.KITCHEN_MCP_PORT || 3001);

const { db, pool } = createDb();
const handler = createMcpHandler(() => createKitchenServer(db));

const app = new Hono();
app.use("/mcp", bearerAuth({ token }));
app.all("/mcp", (c) => handler.fetch(c.req.raw));

const httpServer = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`kitchen-mcp listening on http://localhost:${info.port}/mcp`);
});

const shutdown = async () => {
  await handler.close();
  httpServer.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
