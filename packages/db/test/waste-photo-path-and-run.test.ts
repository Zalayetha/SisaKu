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

describe.skipIf(!url)("migration 0003: waste_entries.photo_path and run_id", () => {
  let pool: pg.Pool;
  const columns = async () =>
    (
      await pool.query(
        "select column_name from information_schema.columns where table_name = 'waste_entries' order by column_name",
      )
    ).rows.map((r: { column_name: string }) => r.column_name);

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url });
    run("reset");
    run("up");
  });
  afterAll(async () => {
    run("up"); // leave the database fully migrated for other test files
    await pool.end();
  });

  it("renames photo_url to photo_path and adds run_id; down restores photo_url", async () => {
    expect(await columns()).toEqual(expect.arrayContaining(["photo_path", "run_id"]));
    expect(await columns()).not.toContain("photo_url");
    run("down 0003_waste_photo_path_and_run");
    expect(await columns()).toContain("photo_url");
    expect(await columns()).not.toEqual(expect.arrayContaining(["photo_path"]));
    expect(await columns()).not.toContain("run_id");
    run("up");
    expect(await columns()).toEqual(expect.arrayContaining(["photo_path", "run_id"]));
  });

  it("rejects a run_id that is not an agent run", async () => {
    const outlet = (await pool.query("insert into outlets(name) values ('A') returning id")).rows[0]
      .id;
    const item = (
      await pool.query(
        "insert into menu_items(outlet_id,name,category,cost_per_portion,portion_weight_kg,food_category) values ($1,'Nasi','c',1,0.2,'rice') returning id",
        [outlet],
      )
    ).rows[0].id;
    await expect(
      pool.query(
        "insert into waste_entries(outlet_id,item_id,weight_kg,cause,source,run_id) values ($1,$2,0.2,'over_prep','text',gen_random_uuid())",
        [outlet, item],
      ),
    ).rejects.toMatchObject({ constraint: "waste_entries_run_id_agent_runs_id_fk" });
  });
});
