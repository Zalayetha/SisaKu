import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, it } from "vitest";

// Requires TEST_DATABASE_URL pointing at an empty Postgres database whose name ends in _test
// (the test rolls the schema back, which drops every table). DATABASE_URL is never used here.
const url = process.env.TEST_DATABASE_URL;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = (d: string) =>
  execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
const tables = async (pool: pg.Pool) =>
  (
    await pool.query(
      "select table_name from information_schema.tables where table_schema='public' order by 1",
    )
  ).rows.map((r) => r.table_name);

it.skipIf(!url)("migrations apply, create 11 tables, and roll back", async () => {
  const pool = new pg.Pool({ connectionString: url });
  try {
    run("up");
    expect(await tables(pool)).toEqual([
      "agent_runs",
      "emission_factors",
      "forecasts",
      "menu_items",
      "outlets",
      "pickup_requests",
      "prep_logs",
      "recommendations",
      "sales",
      "users",
      "waste_entries",
    ]);
    await expect(
      pool
        .query("insert into outlets(name) values ('x') returning id")
        .then((r) =>
          pool.query("insert into users(outlet_id,name,role) values ($1,'u','admin')", [
            r.rows[0].id,
          ]),
        ),
    ).rejects.toThrow();
    run("reset");
    expect(await tables(pool)).toEqual([]);
    run("up");
  } finally {
    await pool.end();
  }
});
