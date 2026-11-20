import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB-backed tests share one database (schema.test rolls it back), so files run one at a time.
    fileParallelism: false,
    // Playwright specs in e2e/ run under `pnpm test:e2e`, not under Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
