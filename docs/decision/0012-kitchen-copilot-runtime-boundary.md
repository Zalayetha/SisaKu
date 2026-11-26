# 0012: Kitchen Copilot runtime boundary

- Date: 2026-11-22
- Status: accepted

## Context

The Kitchen Copilot (ZALS-15) is the conversational agent on Telegram, built on the Anvia SDK and connected through Anvia Channel (`@anvia/telegram`, `@anvia/channel-agent`). It reaches data only through `kitchen-mcp` and `impact-mcp`. Both servers trust the `outlet_id` they are given and leave user-to-outlet mapping and tool allowlists to the agent layer (ADR 0009). Approval happens in fixed code outside MCP (ADR 0011).

That leaves several choices to the agent layer: which MCP tools the Copilot may see, who picks `outlet_id`, how a Telegram sender becomes a user, what happens to strangers and group chats, how the bot receives messages, and where chat history lives. `createChannelAgent` takes one agent instance for all conversations. Its only documented hook per message, `shouldHandle`, can skip a message but cannot answer it. The decisions were grilled in the ZALS-15 session of 2026-11-22.

## Decision

**Tool allowlist**

- The Copilot's tools come from one deny-by-default allowlist in `packages/agents`. MCP tools not on it are dropped before the agent sees them, so a tool added to a server later stays hidden until someone adds it on purpose.
- Final list: `get_menu`, `get_sales`, `get_prep_log`, `query_waste`, `get_factor`, `compute_co2e`, `log_waste`, `update_entry`, `submit_pickup`. ZALS-15 enables only the read tools; ZALS-16 adds `update_entry`, while `log_waste` is called only by fixed code after a confirmation (amended by ADR 0014). ZALS-17 adds `list_entries` (ADR 0015).
- `draft_pickup` is denied. Drafting pickups from surplus belongs to the nightly pipeline, and keeping it out of the chat means a message cannot fill the approval queue. `submit_pickup` is still guarded by the server's approval check (ADR 0011). Revisit if surplus routing (ZALS-28) is built.
- Every role gets the same tools. The role is passed to the agent as context, so it can explain that only a manager or owner can approve.

**Outlet scope**

- `outlet_id` (and later `confirmed_by`) are removed from the tool schemas the LLM sees and filled in from the looked-up user on every call. The model cannot name another outlet. A nightly pipeline step scopes its tools to its run's outlet with no user, and a tool that records who confirmed is then refused when the tools are scoped, so it cannot be called (added 2026-11-26, #91, ADR 0018).
- The turn context names the user's outlet (added 2026-11-25, #69), so the model can tell when a user means another one; without it, it gave this outlet's numbers as the other's. The outlet's name therefore reaches the model provider, but not the trace labels. People's names still reach neither.
- Each user belongs to exactly one outlet, owners included, for the MVP.

**Who may talk to the Copilot**

- The sender's `telegram_user_id` is looked up in `users` by fixed code in `apps/copilot`, reading `@sisaku/db` directly. It is not an MCP tool, so no allowlist mistake can give the LLM a way to look up users. "Agents reach data only through tools" applies to the LLM, not to the fixed code around it.
- Unknown senders get a fixed reply showing their Telegram ID and asking a manager to register them. The agent is not run and no trace is created. Users are registered through the CSV/seed, not in chat.
- Only direct chats are handled; group messages are ignored, so one user's outlet data and approvals are never shown to a group.

**Runtime**

- The agent definition (instructions, model, allowlist, MCP clients, Lens) lives in `packages/agents`. The long-running Telegram service is its own app, `apps/copilot`, with its own lifecycle and SIGTERM handling. Both run from source through tsx with no build step, like the MCP servers (ADR 0009), so `packages/agents` drops the tsup build from ADR 0004.
- The bot receives messages by polling Telegram, both locally and on the VPS. A webhook needs a public HTTPS route, a secret and manual registration, which pays off only with several bot instances.
- MCP servers: spawned over stdio locally and in tests; over HTTP with the bearer token in deploy, selected by environment (ADR 0009). HTTP connections keep the MCP client's SSRF protection (`strict`) unless `MCP_SSRF_PROTECTION=disabled`, which deploy sets because the servers are reached by private Docker service names.
- Chat history is kept in memory, capped at about 20 messages per user, and lost on restart. It is written only once a reply has been delivered, so the model never remembers a message the user did not get (added 2026-11-24, #54). Pending confirm and approval interactions are a separate store; waste guesses are decided in ADR 0014.
- Replies mirror the user's language, defaulting to Bahasa Indonesia.
- A failure during a turn (LLM, MCP tool, database) produces a fixed apology in chat; the real error goes to the Lens trace and logs only. No automatic retry within a turn.
- Every tool in a chat request is sent with `strict: false` (added 2026-11-25, #70). Anvia leaves `strict` out; on 2026-11-24 the model began filling every optional field with invented values, which is what strict tool schemas cause. The provider side was not confirmed as the cause, so requests now state it instead of relying on a default. Anvia has no setting for it, so `createModel` gives it a client built on the `openai` SDK, pinned to the version Anvia resolves.
- Startup fails fast when the Telegram token (`getMe`), model key, `DATABASE_URL`, either MCP connection, or the Lens keys are missing or broken. At runtime Lens is best-effort and never blocks a reply.

**Tracing**

- One Anvia Lens trace per chat turn, with a span per LLM call and tool call, labelled with the agent (`copilot`), outlet id, user id, role and Telegram chat id. No names or Telegram usernames.
- Lens runs in `safe` capture mode: spans keep timings, tokens, cost, tool names and errors, but not prompt, reply, chat history or tool argument and result bodies. Users can type anything, including personal data, so message content never leaves the app. Evals that check tool arguments (the tool-call correctness eval) read them from the agent run in the eval harness, not from Lens. Since 2026-11-24 (#60), eval runs on mock data may trace to Lens with full capture under their own service name, `sisaku-copilot-eval`; real chats stay in safe mode (ADR 0016).
- Chat turns write no `agent_runs` rows until ZALS-16, when a turn first produces a stored waste entry.

## Consequences

- Cross-outlet access through a prompt is impossible by construction rather than by instruction. The cost is a wrapper that rewrites MCP tool schemas and injects arguments, which must be kept in step with the servers' schemas.
- The allowlist test (exact set, `draft_pickup` absent) is the guard against accidental exposure. Changing the Copilot's tools always means editing that list.
- Telegram has no onboarding flow; adding a user means editing the seed or CSV.
- Restarts and deploys wipe chat history. If that annoys users, move history to a persistent store.
- Polling allows only one running bot instance per token; scaling out means switching to a webhook.
- The channel packages are documented as private beta. If they cannot be installed or change shape, the bridge part of `apps/copilot` changes, but these boundary decisions do not.
- Tests: automated tests drive the wrapper with a fake channel event and a stubbed model (reply, unknown sender, injected `outlet_id`, allowlist). A manual smoke check with the real bot and a Lens trace screenshot is recorded in the PR.
