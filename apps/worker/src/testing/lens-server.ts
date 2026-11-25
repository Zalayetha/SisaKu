import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Test-only: a server that takes what the real Lens client sends (OTLP over HTTP, as JSON).

type Attribute = { key: string; value: { stringValue?: string; intValue?: number } };
export type SentSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Attribute[];
};
type Export = {
  resourceSpans?: {
    resource: { attributes: Attribute[] };
    scopeSpans: { spans: SentSpan[] }[];
  }[];
};

export async function startLensServer() {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      bodies.push(body);
      response.setHeader("content-type", "application/json").end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const resources = () =>
    bodies.flatMap((body) => (JSON.parse(body) as Export).resourceSpans ?? []);
  return {
    env: {
      ANVIA_LENS_BASE_URL: `http://127.0.0.1:${port}`,
      ANVIA_LENS_PUBLIC_KEY: "pk",
      ANVIA_LENS_SECRET_KEY: "sk",
    },
    /** Everything sent, as it was sent. */
    raw: () => bodies.join("\n"),
    spans: () => resources().flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans)),
    serviceNames: () =>
      resources().map(
        (r) => r.resource.attributes.find(({ key }) => key === "service.name")?.value.stringValue,
      ),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
