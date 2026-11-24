import { createLens } from "@sisaku/agents";

const LENS_ENV = ["ANVIA_LENS_BASE_URL", "ANVIA_LENS_PUBLIC_KEY", "ANVIA_LENS_SECRET_KEY"];

/**
 * Lens for an eval run, or undefined when it is not configured. Eval traces go under their own
 * service name with full content, because they hold only mock data; production stays in safe
 * capture mode (ADR 0012, ADR 0016).
 */
export function createEvalLens(env: NodeJS.ProcessEnv = process.env) {
  if (!LENS_ENV.every((name) => env[name])) return undefined;
  const client = createLens("sisaku-copilot-eval", env);
  return {
    client,
    observer: client.observer({ captureMode: "full" }),
    reporters: [client.evalReporter({ includePayloads: true })],
  };
}
