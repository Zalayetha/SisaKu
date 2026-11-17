import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// up: apply pending Drizzle migrations. down: revert the initial schema (drizzle/down/*.down.sql).
const dir = new URL("../drizzle/", import.meta.url);
const direction = process.argv[2] ?? "up";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (direction === "up") {
    await migrate(drizzle(pool), { migrationsFolder: dir.pathname });
  } else if (direction === "down") {
    await pool.query(readFileSync(new URL("down/0000_init.down.sql", dir), "utf8"));
    await pool.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  } else throw new Error(`unknown direction ${direction}`);
  console.log(`migrate ${direction}: ok`);
} finally {
  await pool.end();
}
