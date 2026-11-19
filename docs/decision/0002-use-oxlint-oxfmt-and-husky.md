# 0002: Use Oxlint, Oxfmt, and Husky

- Date: 2026-11-17
- Status: accepted

## Context

The repository needs a linter, a formatter, and a check that runs before each commit. The team wants fast tools with few configuration files and no separate Prettier setup.

## Decision

- **Oxlint** lints the whole repository (`pnpm lint`).
- **Oxfmt** formats and checks the repository (`pnpm format`, `pnpm format:check`). Its settings live in `.oxfmtrc.json`, migrated from the earlier Prettier configuration with the same print width, semicolons, and trailing commas.
- **Husky** runs `pnpm lint` and `pnpm typecheck` in the pre-commit hook. It is installed by the `prepare` script.

CI runs the format check, so formatting drift fails the build.

## Consequences

- Formatting and linting use one toolchain, and the configuration is one JSON file.
- Generated files that should not be reformatted are listed in `.oxfmtrc.json` under `ignorePatterns`, including `.github/workflows/pullfrog.yml`.
- Oxfmt is pre-1.0, so its version is pinned with a caret range and the lockfile. Upgrades are deliberate changes.
