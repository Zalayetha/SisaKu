# SisaKu

SisaKu tells commercial kitchens how much to cook tomorrow so less food is binned. Product scope is in `prd.md`; architecture is in `technical-design.md`.

## Setup

Requirements: Node 22 (see `.nvmrc`), pnpm 9.15.9, Docker.

```sh
pnpm install           # also installs Git hooks via Husky
cp .env.example .env   # fill in values; never commit .env
docker compose up -d   # Postgres, Redis, Qdrant
```

## Scripts

| Command             | What it does                               |
| ------------------- | ------------------------------------------ |
| `pnpm lint`         | oxlint across the repo                     |
| `pnpm format:check` | Prettier check (`pnpm format` to fix)      |
| `pnpm typecheck`    | `tsc --noEmit` in every workspace package  |
| `pnpm test`         | Vitest across the repo                     |
| `pnpm build`        | Compile every workspace package to `dist/` |

The pre-commit hook runs `pnpm lint` and `pnpm typecheck`. CI (`.github/workflows/ci.yml`) runs install, lint, format check, typecheck, test, and build on every push.

## Layout

- `apps/api`, `apps/worker`: Hono API and BullMQ worker (placeholders for now)
- `packages/shared`, `packages/db`, `packages/kitchen-mcp`, `packages/impact-mcp`, `packages/agents`: placeholders for the shared code, Drizzle schema, the two MCP servers, and the agents
