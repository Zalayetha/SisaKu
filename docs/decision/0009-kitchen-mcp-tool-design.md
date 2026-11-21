# 0009: kitchen-mcp tool design

- Date: 2026-11-21
- Status: accepted

## Context

`kitchen-mcp` (ZALS-13) is the only path from the agents to sales, menu, prep logs and waste. `technical-design.md` names six tools and two resources and follows the Devscale `mcp-anvia` reference. Several things were open: who enforces which outlet a caller may touch, which calendar day a waste timestamp belongs to, which data may be edited through the tools, how waste is converted to kg, and how invalid input and server faults reach the caller.

## Decision

- **Tools only.** `get_sales`, `get_menu`, `get_prep_log`, `log_waste`, `query_waste`, `update_entry`. The two resources in the design (menu, waste cause list) are dropped for the MVP: agent clients call tools, not resources. `get_menu` covers the menu, and the cause list is the `cause` enum in the tool input schemas.
- **Outlet scope.** Every tool takes `outlet_id`. The server trusts it but checks that the outlet exists and that every item, user and waste entry belongs to it. Mapping a Telegram user to an outlet and each agent's tool allowlist stay in the agent layer. The composite foreign keys (ADR 0008) are the last line of defence.
- **Outlet-local days.** `query_waste` dates are calendar days in `outlets.timezone` (Asia/Jakarta), so waste logged at 21:00 lands on that day, not on the next UTC day.
- **Waste is the only editable data.** Sales come from the POS and prep logs are imported; they are read-only here and are corrected by re-importing a CSV (ADR 0007). `update_entry` edits waste entries only and returns the entry before and after, so the agent can record the correction as feedback in Anvia Lens. The server writes no feedback itself.
- **kg is computed on the server.** `log_waste` takes exactly one of `portion_count` or `weight_kg`; portions are converted with the item's `portion_weight_kg`. `update_entry` recomputes kg when the portion count or item changes, and clears the portion count when a weight is typed.
- **Numbers for reports come from SQL.** `query_waste` returns `waste_kg`, `entries`, estimated `portions` and `cost_idr` per group, so the report faithfulness eval can compare against the database instead of LLM arithmetic.
- **Bounded reads.** `get_sales` accepts at most 92 days per call.
- **Validation and errors.** zod 4 schemas validate input before a handler runs; failures come back as MCP tool errors (`isError`) with the field and reason. Errors the caller can fix (unknown outlet, item from another outlet, future `logged_at`) are returned as-is. Anything else is logged to stderr and returned as a generic message, so SQL details never reach the model.
- **Typed results.** Each tool declares an `outputSchema` and returns `structuredContent` plus the same data as JSON text.
- **Waste causes live in `@sisaku/db`** as `WASTE_CAUSES`, next to the `waste_entries` schema. The column stays text, so adding a cause needs no migration; mock-data and kitchen-mcp import the list.
- **Packages.** `@modelcontextprotocol/server` v2, `zod`, `hono` and `@hono/node-server`. `@anvia/mcp` is the client side and belongs in `packages/agents`, not here.
- **Transports.** `start:stdio` for local use, Anvia Studio and the MCP Inspector. `start:http` serves `/mcp` behind `bearerAuth`, reads `KITCHEN_MCP_TOKEN` and `KITCHEN_MCP_PORT` (default 3001), and refuses to start without the token. There is no unauthenticated HTTP variant.
- **Runs from source.** Like `packages/mock-data`, the package runs through tsx and has no build step (a tsup build would need `@sisaku/db` built first, and CI typechecks before building). The root Vitest config aliases `@sisaku/db` to its source for the same reason.

## Consequences

- Any MCP client holding the HTTP token can act for any outlet. That is acceptable while the token lives only on the VPS with the agents; per-caller scoping would need a token per outlet or per agent.
- The MVP has no resources. If a client that reads resources (for example Claude Desktop) becomes important, the menu and cause list can be added on top of the same queries.
- Tests: `src/kitchen.test.ts` covers each tool's logic against Postgres; `src/server.test.ts` calls every tool through an in-memory MCP client, including invalid input. Validation tests need no database. CI now runs a Postgres service with `TEST_DATABASE_URL`, which also turns on the existing `packages/db` tests.
- `portion_weight_kg` can be 0 (no `CHECK` constraint; the CSV importer accepts it). Such an item still counts toward `waste_kg` but is left out of estimated portions and `cost_idr`, and logging portions for it is rejected with a request to log `weight_kg`. Rejecting 0 at import and in the schema is a follow-up.
- Photo handling is decided separately in ADR 0010.
