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

describe.skipIf(!url)("migration 0005: pipeline runs", () => {
  let pool: pg.Pool;
  let outletId: string;

  const insertRun = async (agent: string, trigger: string, date: string | null) =>
    (
      await pool.query(
        "insert into agent_runs(agent, trigger, outlet_id, business_date) values ($1,$2,$3,$4) returning id",
        [agent, trigger, date ? outletId : null, date],
      )
    ).rows[0].id as string;
  const insertJob = async (runId: string, step: string) =>
    (
      await pool.query("insert into pipeline_jobs(run_id, step) values ($1,$2) returning id", [
        runId,
        step,
      ])
    ).rows[0].id as string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    run("reset");
    run("up");
    outletId = (await pool.query("insert into outlets(name) values ('x') returning id")).rows[0].id;
  });
  afterAll(async () => {
    run("up"); // leave the database fully migrated for other test files
    await pool.end();
  });

  it("allows one scheduled run per outlet and date, any number of manual ones", async () => {
    await insertRun("nightly-pipeline", "schedule", "2026-03-01");
    await expect(insertRun("nightly-pipeline", "schedule", "2026-03-01")).rejects.toThrow(/unique/);
    await insertRun("nightly-pipeline", "schedule", "2026-03-02");
    await insertRun("nightly-pipeline", "manual", "2026-03-01");
    await insertRun("nightly-pipeline", "manual", "2026-03-01");
  });

  it("leaves Copilot runs without outlet and date", async () => {
    await insertRun("copilot", "telegram", null);
    await insertRun("copilot", "telegram", null);
  });

  it("holds one job per step of a run, and one result per job", async () => {
    const runId = await insertRun("nightly-pipeline", "manual", "2026-03-03");
    const jobId = await insertJob(runId, "ingest");
    await expect(insertJob(runId, "ingest")).rejects.toThrow(/unique/);
    await expect(insertJob(runId, "lunch")).rejects.toThrow(/pipeline_step/);
    const result = "insert into pipeline_job_results(job_id, output) values ($1, '{}')";
    await pool.query(result, [jobId]);
    await expect(pool.query(result, [jobId])).rejects.toThrow(/unique/);
  });

  it("down removes it, up restores it", async () => {
    run("down 0005_pipeline_runs");
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name = 'agent_runs'",
    );
    const columns = rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).not.toContain("business_date");
    const types = await pool.query("select typname from pg_type where typname like 'pipeline_%'");
    expect(types.rows).toEqual([]);
    run("up");
  });
});
