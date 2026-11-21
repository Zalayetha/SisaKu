import { readFileSync } from "node:fs";
import { createDb, formatErrors, importCsv, IMPORT_ORDER, type CsvTableName } from "../src/index";

// Usage: pnpm --filter @sisaku/db db:import-csv <dir>   (reads <table>.csv for each table present)
const dir = process.argv[2];
if (!dir)
  throw new Error(
    "usage: import-csv <directory containing any of outlets.csv, menu_items.csv, sales.csv, prep_logs.csv, emission_factors.csv>",
  );
const files: Partial<Record<CsvTableName, string>> = {};
for (const name of IMPORT_ORDER) {
  try {
    files[name] = readFileSync(`${dir}/${name}.csv`, "utf8");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
}
if (!Object.keys(files).length) throw new Error(`no CSV files found in ${dir}`);
const { db, pool } = createDb();
try {
  const r = await importCsv(db, files);
  if (!r.ok) {
    for (const e of r.errors) console.error(...formatErrors(e.file + ".csv", [e]));
    console.error(`import rejected: ${r.errors.length} error(s); nothing was written`);
    process.exitCode = 1;
  } else console.log("import ok:", r.inserted);
} finally {
  await pool.end();
}
