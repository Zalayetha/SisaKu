const DEFAULT_USER = "operator";
const DEFAULT_PORT = 3003;
/** Only this machine. On the VPS the board is reached through a tunnel (#42). */
const DEFAULT_HOST = "127.0.0.1";

/** The board's settings. Refuses to go on without a password. */
export function boardSettings(env: NodeJS.ProcessEnv = process.env) {
  const password = env.BULL_BOARD_PASSWORD;
  if (!password?.trim()) throw new Error("BULL_BOARD_PASSWORD is not set");
  const port = Number(env.API_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`API_PORT is not a port: ${env.API_PORT}`);
  }
  return {
    user: env.BULL_BOARD_USER || DEFAULT_USER,
    password,
    host: env.API_HOST || DEFAULT_HOST,
    port,
  };
}
