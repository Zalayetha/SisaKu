import { LensClient } from "@anvia/lens";

const LENS_ENV = ["ANVIA_LENS_BASE_URL", "ANVIA_LENS_PUBLIC_KEY", "ANVIA_LENS_SECRET_KEY"] as const;

/** The Anvia Lens client. Refuses to start without its three settings. */
export function createLens(serviceName: string, env: NodeJS.ProcessEnv = process.env) {
  const missing = LENS_ENV.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`${missing.join(", ")} not set`);
  return new LensClient({
    baseUrl: env.ANVIA_LENS_BASE_URL,
    publicKey: env.ANVIA_LENS_PUBLIC_KEY,
    secretKey: env.ANVIA_LENS_SECRET_KEY,
    serviceName,
  });
}
