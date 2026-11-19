# SisaKu

SisaKu tells commercial kitchens how much to cook tomorrow so less food is binned. Product scope is in `prd.md`; architecture is in `technical-design.md`.

## Setup

Requirements: Node 24.12.0 (see `.nvmrc`), pnpm 9.15.9, Docker.

```sh
pnpm install           # also installs Git hooks via Husky
cp .env.example .env   # fill in values; never commit .env
docker compose up -d   # Postgres, Redis, Qdrant
```

## Scripts

| Command             | What it does                               |
| ------------------- | ------------------------------------------ |
| `pnpm lint`         | oxlint across the repo                     |
| `pnpm format:check` | Oxfmt check (`pnpm format` to fix)         |
| `pnpm typecheck`    | `tsc --noEmit` in every workspace package  |
| `pnpm test`         | Vitest across the repo                     |
| `pnpm build`        | Compile every workspace package to `dist/` |
| `pnpm test:e2e`     | Playwright tests in `e2e/` (root)          |

The pre-commit hook runs `pnpm lint` and `pnpm typecheck`. CI (`.github/workflows/ci.yml`) runs install, lint, format check, typecheck, test, and build on every push, plus a separate Playwright e2e job.

Decisions and product notes are in `docs/` (see `AGENTS.md` for the index and format).

## Layout

- `apps/api`, `apps/worker`: Hono API and BullMQ worker (placeholders for now)
- `packages/shared`, `packages/db`, `packages/kitchen-mcp`, `packages/impact-mcp`, `packages/agents`: placeholders for the shared code, Drizzle schema, the two MCP servers, and the agents
