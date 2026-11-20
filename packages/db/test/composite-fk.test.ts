import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Requires TEST_DATABASE_URL (database name ending in _test). Runs `reset` then `up`, so it
// wipes that database. schema.test.ts does the same; the root vitest config sets
// fileParallelism: false so the two never run against it at once.
const url = process.env.TEST_DATABASE_URL;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = (d: string) =>
  execSync(`pnpm exec tsx scripts/migrate.ts ${d}`, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });

describe.skipIf(!url)("outlet/item pairing", () => {
  let pool: pg.Pool;
  let outletA: string;
  let outletB: string;
  let itemA: string;
  let runId: string;
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0].id;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    run("reset");
    run("up");
    outletA = await one("insert into outlets(name) values ('A') returning id");
    outletB = await one("insert into outlets(name) values ('B') returning id");
    itemA = await one(
      "insert into menu_items(outlet_id,name,category,cost_per_portion,portion_weight_kg,food_category) values ($1,'n','c',1,0.1,'rice') returning id",
      [outletA],
    );
    runId = await one("insert into agent_runs(agent,trigger) values ('a','t') returning id");
  });
  afterAll(async () => {
    await pool.end();
  });

  // Each statement takes ($1 = outlet_id, $2 = item_id, $3 = run id).
  const inserts: Record<string, string> = {
    sales: "insert into sales(outlet_id,item_id,date,qty_sold) values ($1,$2,'2026-01-01',1)",
    prep_logs:
      "insert into prep_logs(outlet_id,item_id,date,qty_prepped) values ($1,$2,'2026-01-01',1)",
    waste_entries:
      "insert into waste_entries(outlet_id,item_id,weight_kg,cause,source) values ($1,$2,1,'x','text')",
    forecasts:
      "insert into forecasts(outlet_id,item_id,run_id,date,baseline_qty,model) values ($1,$2,$3,'2026-01-01',1,'m')",
  };
  const insert = (table: string, outlet: string, item: string) =>
    pool.query(inserts[table]!, table === "forecasts" ? [outlet, item, runId] : [outlet, item]);

  for (const table of Object.keys(inserts)) {
    it(`${table}: rejects an item from another outlet, accepts a matching pair`, async () => {
      await expect(insert(table, outletB, itemA)).rejects.toThrow(/_item_outlet_fk/);
      await expect(insert(table, outletA, itemA)).resolves.toBeTruthy();
    });
  }

  it("down reverts only 0001; up re-applies", async () => {
    run("down");
    // the old, weaker guarantee: another outlet's item is accepted
    await expect(insert("sales", outletB, itemA)).resolves.toBeTruthy();
    await pool.query("delete from sales where outlet_id=$1", [outletB]);
    run("up");
    await expect(insert("sales", outletB, itemA)).rejects.toThrow();
  });

  it("up fails with a clear message when existing rows violate the pairing", async () => {
    run("down");
    await insert("sales", outletB, itemA);
    let msg = "";
    try {
      run("up");
    } catch (e) {
      msg = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(msg).toContain("rows pair an item with another outlet (table: count): sales: 1");
    await pool.query("delete from sales where outlet_id=$1", [outletB]);
    run("up");
  });
});
