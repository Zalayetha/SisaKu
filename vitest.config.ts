import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs in e2e/ run under `pnpm test:e2e`, not under Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
