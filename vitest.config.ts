import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace packages run from source in tests; CI runs tests before `pnpm build`.
    alias: {
      "@sisaku/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@sisaku/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // DB-backed tests share one database (schema.test rolls it back), so files run one at a time.
    fileParallelism: false,
    // Playwright specs in e2e/ run under `pnpm test:e2e`, not under Vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
