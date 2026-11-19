import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { test } from "node:test";
import pg from "pg";

// Requires DATABASE_URL pointing at an empty Postgres database.
const url = process.env.DATABASE_URL;
const run = (d: string) => execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, { stdio: "pipe" });
const tables = async (pool: pg.Pool) =>
  (await pool.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);

test("migrations apply, create 11 tables, and roll back", { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  try {
    run("up");
    assert.deepEqual(await tables(pool), [
      "agent_runs", "emission_factors", "forecasts", "menu_items", "outlets", "pickup_requests",
      "prep_logs", "recommendations", "sales", "users", "waste_entries",
    ]);
    await assert.rejects(pool.query("insert into outlets(name) values ('x') returning id").then((r) =>
      pool.query("insert into users(outlet_id,name,role) values ($1,'u','admin')", [r.rows[0].id])));
    run("down");
    assert.deepEqual(await tables(pool), []);
    run("up");
  } finally {
    await pool.end();
  }
});
