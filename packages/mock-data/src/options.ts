import { DEFAULT_DAYS, DEFAULT_SEED, DEFAULT_START, HELD_OUT_DAYS } from "./generate.js";

export interface CliOptions {
  seed: number;
  start: string;
  days: number;
  reset: boolean;
  dryRun: boolean;
}

const VALUE_FLAGS = new Set(["seed", "start", "days"]);
const BOOL_FLAGS = new Set(["reset", "dry-run"]);

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseInteger(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) throw new Error(`--${name} must be an integer, got "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} is out of range: "${raw}"`);
  return n;
}

/** Parse and validate CLI args. Throws an Error with a user-facing message. */
export function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      values.set(name, value);
      i++;
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }

  const seed = values.has("seed") ? parseInteger("seed", values.get("seed")!) : DEFAULT_SEED;
  const days = values.has("days") ? parseInteger("days", values.get("days")!) : DEFAULT_DAYS;
  if (days < HELD_OUT_DAYS) {
    throw new Error(`--days must be at least ${HELD_OUT_DAYS} (the held-out window), got ${days}`);
  }
  const start = values.get("start") ?? DEFAULT_START;
  if (!isValidDate(start))
    throw new Error(`--start must be a valid YYYY-MM-DD date, got "${start}"`);

  return { seed, start, days, reset: flags.has("reset"), dryRun: flags.has("dry-run") };
}
