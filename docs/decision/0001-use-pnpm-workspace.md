# 0001: Use a pnpm workspace

- Date: 2026-11-17
- Status: accepted

## Context

SisaKu has two deployable apps (the Hono API and the BullMQ worker) and several shared packages (database schema, two MCP servers, agents). They need to share types and tooling without publishing anything.

## Decision

Use a single pnpm workspace at the repository root. Apps live in `apps/*` and packages in `packages/*`. pnpm is pinned to 9.15.9 through `packageManager`, and CI installs with `--frozen-lockfile`.

## Consequences

- One lockfile and one set of root scripts (`lint`, `format`, `typecheck`, `test`, `build`).
- Each workspace package has its own `typecheck` and `build` scripts, which the root runs with `pnpm -r --if-present`.
- Adding a package means adding a directory under `apps/` or `packages/`. No registry publishing is planned.
