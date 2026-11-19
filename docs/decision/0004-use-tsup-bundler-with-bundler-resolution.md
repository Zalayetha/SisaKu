# 0004: Use tsup as the bundler and Bundler module resolution

- Date: 2026-11-19
- Status: accepted

## Context

Every workspace package is an ES module (`"type": "module"`) and its `main` points at `dist/index.js`. With `module` and `moduleResolution` set to `NodeNext`, TypeScript requires every relative import to carry a `.js` extension, for example `import { x } from "./x.js"`. The team wants extensionless imports.

Plain `tsc` cannot provide that. With `moduleResolution: Bundler`, `tsc` accepts extensionless imports but emits them unchanged, and Node then fails with `ERR_MODULE_NOT_FOUND`. A bundler has to resolve the imports during the build.

## Decision

- **Module resolution:** `tsconfig.base.json` uses `"module": "ESNext"` and `"moduleResolution": "Bundler"`. Source files use extensionless relative imports.
- **Bundler:** `tsup` (root dev dependency, pinned with a caret range). Each package builds with `tsup src/index.ts --format esm --dts --clean --tsconfig tsconfig.build.json --out-dir dist`. It bundles relative imports into `dist/` and emits the `.d.ts` file.
- **Typecheck:** `pnpm typecheck` still runs `tsc` on `tsconfig.json`, which includes test files. `tsconfig.build.json` excludes `src/**/*.test.ts` and is used only by the build.
- **Runtime:** Node runs the bundled `dist/` output directly. No `tsx` or other runner is needed.

## Consequences

- Source imports need no file extensions.
- `dist/` is self-contained for relative imports. Workspace packages are not bundled into each other, so a package that depends on another must still import it by package name and build it first.
- tsup is a build-time tool and adds one dependency (esbuild) to the lockfile.
- If a future package needs a different output (for example CommonJS or several entry points), change that package's `build` script. The decision covers the default.
