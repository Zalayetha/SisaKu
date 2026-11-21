import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Requires TEST_DATABASE_URL (database name ending in _test). Runs `reset` then `up`, so it
// wipes that database; the root vitest config sets fileParallelism: false.
const url = process.env.TEST_DATABASE_URL;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = (d: string) =>
  execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
const CONSTRAINT = "menu_items_portion_weight_kg_positive";

describe.skipIf(!url)("menu_items.portion_weight_kg > 0", () => {
  let pool: pg.Pool;
  let outlet: string;
  const insertItem = (name: string, kg: string) =>
    pool.query(
      "insert into menu_items(outlet_id,name,category,cost_per_portion,portion_weight_kg,food_category) values ($1,$2,'c',1,$3,'rice')",
      [outlet, name, kg],
    );
  const hasConstraint = async () =>
    (await pool.query("select 1 from pg_constraint where conname = $1", [CONSTRAINT])).rowCount ===
    1;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    run("reset");
    run("up");
    outlet = (await pool.query("insert into outlets(name) values ('A') returning id")).rows[0].id;
  });
  afterAll(async () => {
    run("up"); // leave the database fully migrated for other test files
    await pool.end();
  });

  it("rejects a zero or negative portion weight and accepts a positive one", async () => {
    await expect(insertItem("zero", "0")).rejects.toMatchObject({ constraint: CONSTRAINT });
    await expect(insertItem("negative", "-0.1")).rejects.toMatchObject({ constraint: CONSTRAINT });
    await expect(insertItem("ok", "0.001")).resolves.toBeDefined();
  });

  it("rolls back and re-applies", async () => {
    run("down");
    expect(await hasConstraint()).toBe(false);
    run("up");
    expect(await hasConstraint()).toBe(true);
  });

  it("refuses to apply over existing zero-weight rows, with a count and names", async () => {
    run("down");
    await insertItem("Kerupuk", "0");
    await insertItem("Es Teh", "0.000");
    let message = "";
    try {
      run("up");
    } catch (e) {
      message = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(message).toMatch(/2 menu_items have portion_weight_kg <= 0/);
    expect(message).toMatch(/Es Teh \(.+\), Kerupuk/);
    expect(await hasConstraint()).toBe(false);
    await pool.query("delete from menu_items where portion_weight_kg <= 0");
  });
});
