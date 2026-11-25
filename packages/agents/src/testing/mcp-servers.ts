import { McpClient, McpClientGroup } from "@anvia/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { createDb } from "@sisaku/db";
import { createImpactServer } from "@sisaku/impact-mcp";
import { createKitchenServer } from "@sisaku/kitchen-mcp";

// Shared by the Copilot's tests and evals and the worker's tests: the real MCP servers, in-process.

type Db = ReturnType<typeof createDb>["db"];

function inMemoryClient(name: string, connect: (transport: InMemoryTransport) => Promise<void>) {
  return new McpClient({
    name,
    versionNegotiation: { mode: "auto" },
    transport: {
      type: "custom",
      create: async () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await connect(serverSide);
        return clientSide;
      },
    },
  });
}

/** kitchen-mcp and impact-mcp on `db`, connected over in-memory transport. */
export function connectInMemoryServers(db: Db): Promise<McpClientGroup> {
  return McpClientGroup.connect({
    clients: [
      inMemoryClient("kitchen", (t) => createKitchenServer(db).connect(t)),
      inMemoryClient("impact", (t) => createImpactServer(db).connect(t)),
    ],
  });
}
