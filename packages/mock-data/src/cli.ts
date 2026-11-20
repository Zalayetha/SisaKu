import { generateMockData } from "./generate.js";
import { loadDataset } from "./load.js";
import { parseCliOptions } from "./options.js";

// Usage: pnpm --filter @sisaku/mock-data seed [--seed N] [--start YYYY-MM-DD] [--days N] [--reset] [--dry-run]
let opts;
try {
  opts = parseCliOptions(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}

const data = generateMockData({ seed: opts.seed, startDate: opts.start, days: opts.days });

console.log(
  `SIMULATED data (seed ${data.seed}, ${data.startDate}..${data.endDate}): ` +
    `${data.outlets.length} outlets, ${data.menuItems.length} items, ${data.sales.length} sales, ` +
    `${data.prepLogs.length} prep logs, ${data.wasteEntries.length} waste entries, ${data.spikes.length} hidden spikes`,
);

if (opts.dryRun) process.exit(0);
await loadDataset(data, { reset: opts.reset });
console.log("Loaded into Postgres.");
