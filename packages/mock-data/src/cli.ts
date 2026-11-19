import { DEFAULT_DAYS, DEFAULT_SEED, DEFAULT_START, generateMockData } from "./generate.js";
import { loadDataset } from "./load.js";

// Usage: pnpm --filter @sisaku/mock-data seed [--seed N] [--start YYYY-MM-DD] [--days N] [--reset] [--dry-run]
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const data = generateMockData({
  seed: Number(opt("seed") ?? DEFAULT_SEED),
  startDate: opt("start") ?? DEFAULT_START,
  days: Number(opt("days") ?? DEFAULT_DAYS),
});

console.log(
  `SIMULATED data (seed ${data.seed}, ${data.startDate}..${data.endDate}): ` +
    `${data.outlets.length} outlets, ${data.menuItems.length} items, ${data.sales.length} sales, ` +
    `${data.prepLogs.length} prep logs, ${data.wasteEntries.length} waste entries, ${data.spikes.length} hidden spikes`,
);

if (args.includes("--dry-run")) process.exit(0);
await loadDataset(data, { reset: args.includes("--reset") });
console.log("Loaded into Postgres.");
