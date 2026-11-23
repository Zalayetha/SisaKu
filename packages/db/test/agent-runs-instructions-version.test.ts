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

describe.skipIf(!url)("migration 0004: agent_runs.instructions_version", () => {
  let pool: pg.Pool;
  const columns = async () =>
    (
      await pool.query(
        "select column_name from information_schema.columns where table_name = 'agent_runs'",
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

  it("adds instructions_version, and down removes it", async () => {
    expect(await columns()).toContain("instructions_version");
    run("down 0004_agent_runs_instructions_version");
    expect(await columns()).not.toContain("instructions_version");
    run("up");
    expect(await columns()).toContain("instructions_version");
  });
});
