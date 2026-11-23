# SisaKu

SisaKu tells commercial kitchens how much to cook tomorrow so less food is binned. Product scope is in `prd.md`; architecture is in `technical-design.md`.

## Setup

Requirements: Node 24.12.0 (see `.nvmrc`), pnpm 9.15.9, Docker.

```sh
pnpm install           # also installs Git hooks via Husky
cp .env.example .env   # fill in values; never commit .env
docker compose up -d   # Postgres, Redis, Qdrant
```

The Copilot also needs Anvia Lens for tracing: start it from `infra/lens` (see `infra/lens/README.md`) and put its keys in `.env`.

## Scripts

| Command             | What it does                               |
| ------------------- | ------------------------------------------ |
| `pnpm lint`         | oxlint across the repo                     |
| `pnpm format:check` | Oxfmt check (`pnpm format` to fix)         |
| `pnpm typecheck`    | `tsc --noEmit` in every workspace package  |
| `pnpm test`         | Vitest across the repo                     |
| `pnpm build`        | Compile every workspace package to `dist/` |
| `pnpm test:e2e`     | Playwright tests in `e2e/` (root)          |
| `pnpm copilot`      | Run the Kitchen Copilot Telegram bot       |

The pre-commit hook runs `pnpm lint` and `pnpm typecheck`. CI (`.github/workflows/ci.yml`) runs install, lint, format check, typecheck, test, and build on every push, plus a separate Playwright e2e job.

Decisions and product notes are in `docs/` (see `AGENTS.md` for the index and format).

## Layout

- `apps/api`, `apps/worker`: Hono API and BullMQ worker (placeholders for now)
- `apps/copilot`: the Kitchen Copilot Telegram bot (polling). Needs `TELEGRAM_BOT_TOKEN`, `LLM_API_KEY`, `DATABASE_URL`, `PHOTOS_DIR` (a writable folder for waste photos) and the three `ANVIA_LENS_*` settings; it spawns both MCP servers over stdio unless `KITCHEN_MCP_URL` / `IMPACT_MCP_URL` are set (ADR 0012). A sender is answered only if their Telegram ID is in `users.telegram_user_id`. Waste photos and texts become a waste guess card; only a tap on Simpan saves it (ADR 0014). Data questions are answered from the tools, with at most one chart per answer drawn in-process (ADR 0015).
- `infra/lens`: self-hosted Anvia Lens, its own Compose project (ADR 0013)
- `packages/shared`, `packages/db`, `packages/kitchen-mcp`, `packages/impact-mcp`, `packages/agents`: placeholders for the shared code, Drizzle schema, the two MCP servers, and the agents
