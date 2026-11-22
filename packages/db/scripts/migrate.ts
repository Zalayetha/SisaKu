import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// up:    apply pending Drizzle migrations.
// down:  revert the latest applied migration (drizzle/down/<tag>.down.sql).
// down <tag>: revert newest-first until <tag> itself has been reverted.
// reset: revert every applied migration and drop the drizzle schema (empty database).
const dir = new URL("../drizzle/", import.meta.url);
const direction = process.argv[2] ?? "up";
const target = process.argv[3];
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")) as {
  entries: { tag: string }[];
};
const pool = new pg.Pool({ connectionString });
const applied = async (): Promise<number> => {
  const r = await pool.query("select to_regclass('drizzle.__drizzle_migrations') as t");
  if (!r.rows[0].t) return 0;
  return Number(
    (await pool.query("select count(*) from drizzle.__drizzle_migrations")).rows[0].count,
  );
};
// Reverting 0000 drops every table, so refuse unless the database name ends in `_test`
// (or the caller explicitly opts in with ALLOW_DESTRUCTIVE_DB=1).
const guardDestructive = () => {
  if (process.env.ALLOW_DESTRUCTIVE_DB === "1") return;
  const name = new URL(connectionString).pathname.slice(1);
  if (!name.endsWith("_test")) {
    throw new Error(
      `refusing destructive "${direction}" on database "${name}": name must end in _test`,
    );
  }
};
const revert = async (idx: number) => {
  const tag = journal.entries[idx]?.tag;
  if (!tag) throw new Error(`no migration at index ${idx}`);
  await pool.query(readFileSync(new URL(`down/${tag}.down.sql`, dir), "utf8"));
  // Keep drizzle's bookkeeping in step so `up` re-applies this migration.
  if (idx > 0) {
    await pool.query(
      "delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)",
    );
  }
};
try {
  if (direction === "up") {
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(dir) });
  } else if (direction === "down") {
    const n = await applied();
    if (n === 0) throw new Error("nothing to revert");
    const stop = target ? journal.entries.findIndex((e) => e.tag === target) : n - 1;
    if (stop < 0) throw new Error(`unknown migration ${target}`);
    if (stop >= n) throw new Error(`${target} is not applied`);
    if (stop === 0) guardDestructive();
    for (let i = n - 1; i >= stop; i--) await revert(i);
    if (stop === 0) await pool.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  } else if (direction === "reset") {
    guardDestructive();
    for (let n = await applied(); n > 0; n--) await revert(n - 1);
    await pool.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  } else throw new Error(`unknown direction ${direction}`);
  console.log(`migrate ${direction}: ok`);
} finally {
  await pool.end();
}
