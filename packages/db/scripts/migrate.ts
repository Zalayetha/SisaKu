import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// up: apply pending Drizzle migrations. down: revert the initial schema (drizzle/down/*.down.sql).
const dir = new URL("../drizzle/", import.meta.url);
const direction = process.argv[2] ?? "up";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
// `down` drops every table, so refuse to run unless the database name ends in `_test`
// (or the caller explicitly opts in with ALLOW_DESTRUCTIVE_DB=1).
if (direction === "down" && process.env.ALLOW_DESTRUCTIVE_DB !== "1") {
  const name = new URL(connectionString).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(`refusing destructive "down" on database "${name}": name must end in _test`);
  }
}
const pool = new pg.Pool({ connectionString });
try {
  if (direction === "up") {
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(dir) });
  } else if (direction === "down") {
    await pool.query(readFileSync(new URL("down/0000_init.down.sql", dir), "utf8"));
    await pool.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  } else throw new Error(`unknown direction ${direction}`);
  console.log(`migrate ${direction}: ok`);
} finally {
  await pool.end();
}
