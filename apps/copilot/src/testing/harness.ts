import { McpClient, McpClientGroup } from "@anvia/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createImpactServer } from "@sisaku/impact-mcp";
import { createKitchenServer } from "@sisaku/kitchen-mcp";
import type { ChartRenderer, ChartSpec } from "../charts/render";
import type { Db } from "../users";
import type { FeedbackScorer } from "../waste/feedback";
import type { PhotoStore } from "../waste/photos";

// Shared by the turn handler tests and the Copilot evals: the real MCP servers in-process, and
// fakes for the photos volume, the chart renderer and Lens scores.

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

/** Stands in for the photos volume. */
export class FakePhotoStore implements PhotoStore {
  readonly saved: { path: string; data: Buffer }[] = [];
  async save(path: string, data: Buffer) {
    this.saved.push({ path, data });
    return path;
  }
}

/** Stands in for the chart renderer: keeps every spec, returns fake PNG bytes. */
export class RecordingRenderer implements ChartRenderer {
  readonly specs: ChartSpec[] = [];
  constructor(private readonly failing = false) {}
  async render(spec: ChartSpec) {
    if (this.failing) throw new Error("resvg crashed");
    this.specs.push(spec);
    return Buffer.from("png");
  }
  /** The data rows of the latest chart. */
  values() {
    return (this.specs.at(-1)!.data as { values: unknown[] }).values;
  }
}

/** Stands in for Lens scores. */
export class RecordingScorer implements FeedbackScorer {
  readonly scores: Parameters<FeedbackScorer["score"]>[0][] = [];
  score(args: Parameters<FeedbackScorer["score"]>[0]) {
    this.scores.push(args);
  }
}
