# 0015: Copilot data answers and charts

- Date: 2026-11-23
- Status: accepted

## Context

ZALS-17 asks the Kitchen Copilot to answer data questions, such as "why did rendang waste spike this week?", with numbers from `query_waste` and `get_sales` and with a chart sent in Telegram. It also asks for the 25 scripted questions of the tool-call correctness eval (technical design), each with the expected first tool call and arguments. Rule 1 of the instructions says every number comes from a tool result, and Lens records no message content (ADR 0012), so a chart must not add numbers the model typed. Two more facts shaped the design. The model needed a `get_menu` call before any item-level question, which would make that call the expected first tool of most eval questions. And nothing tied eval results to the instruction text that produced them. The decisions were grilled in the ZALS-17 session of 2026-11-23.

## Decision

**The menu is in the turn context**

- Each turn reads the outlet's menu once and puts its names and ids in the instructions' turn context. Rule 8 now says "call propose_waste_entry" instead of "call get_menu, then propose_waste_entry", and `propose_waste_entry` uses the same menu. `get_menu` stays available for cost, weight and food category; kitchen-mcp's tool descriptions no longer send the model to it for item ids, in neutral wording because the nightly pipeline shares them.

**"Why" questions follow a fixed recipe**

- Rule 10: call `query_waste` grouped by day for the item over the period asked plus the 14 days before it, then `get_sales` for the same item and days, then `query_waste` grouped by cause for the item over the period asked and over the 14 days before it, and compare. A cause is named only as "likely", and only when the data shows it (a sales drop or a change of waste cause). At most 5 tool calls for one question. This mirrors the nightly pipeline's Analyze step.

**The model asks for a chart; fixed code queries and draws it**

- A local tool, `send_chart`, takes a query, never numbers. Its three kinds are:
  - `waste_trend`: waste per outlet-local day, in kg or estimated Rupiah, optionally for one item or cause;
  - `waste_vs_sales`: one item, with waste portions above sales portions on the same days;
  - `waste_breakdown`: the top 10 items or causes.
- A chart covers at most 92 days (the `get_sales` limit, ADR 0009). Fixed code calls `query_waste` and `get_sales` for the sender's outlet and fills days without data with zero. No free-form specs.
- The tool returns `{ sent: true, title, note }`. With no data, or a range of a single day (a trend or waste-vs-sales chart), it returns `{ sent: false, reason: "no_data" }` and draws nothing. Invalid input, an item that is not on the outlet's menu, a second chart in the same turn, or a render failure return an error, so the model answers in text.
- Rule 11: use a chart for trends and comparisons, or when the user asks for one (then `send_chart` comes first). Simple totals are answered in text. The reply still gives the key numbers and does not describe the chart.
- Rendering is Vega-Lite → SVG → PNG with `@resvg/resvg-js`, inside the copilot process, so no outlet data goes to a chart service. resvg loads only the bundled Noto Sans (OFL, in `apps/copilot/assets/fonts`), because a slim container has no system fonts. Labels and titles are fixed Bahasa Indonesia, with Indonesian number format.
- The renderer is a turn dependency (a spec in, PNG bytes out), like the photo store and the scorer, so tests check the spec's data rows against the database.
- Delivery: the text reply goes first, then the chart as a photo. The Anvia Telegram adapter sends attachments without a caption, so the title is drawn on the chart instead. A failed photo send is logged; the text is already delivered.
- Any role may ask data questions and get charts, cost included (ADR 0012).

**Corrections find the entry with `list_entries`**

- `query_waste` returns totals without entry ids, so the model could not name the entry for `update_entry`. kitchen-mcp gets a read tool, `list_entries(outlet, from, to, item_id?, cause?)`. It returns single entries newest first (id, item, time, outlet-local day, kg, portions, cause, source), at most 20, with `truncated` when more matched. It is on the Copilot allowlist. Rule 9 now says to find the entry with `list_entries`, then call `update_entry` with its id, and to ask the user when several entries could match. `query_waste` stays the tool for totals (ADR 0009).

**Instruction versions and their changelog**

- `COPILOT_INSTRUCTIONS_VERSION` covers the instructions and every tool description the model sees. Every change bumps it and adds an entry, newest first, to `packages/agents/INSTRUCTIONS-CHANGELOG.md`. Each entry gives the date, issue, a fingerprint of the instructions text, rule text, why, and the eval it should move. A test fails when the newest entry's version does not match the constant, or when its fingerprint (SHA-256 of `COPILOT_INSTRUCTIONS`, first 16 hex characters) does not match the current text, so an instruction edit without a new version cannot pass. Tool descriptions are not fingerprinted; their bumps stay by hand. `AGENTS.md` states the rule.
- Each Copilot trace carries the version as Lens metadata. The `agent_runs` rows the Copilot writes (one per saved waste guess, ADR 0014) store it in the new nullable column `instructions_version` (migration 0004, with a down migration).

**The eval dataset**

- `apps/copilot/evals/tool-call/questions.json` holds 25 cases, about 60% in Bahasa Indonesia. Each case has `id`, `area`, `message`, `language`, `role`, `today` (the last day of the default mock data, 2026-04-01) and `expected: { tool, args }`. Since 2026-11-24 (#54) it holds 26 cases, and a case may give `history`: earlier chat as user/assistant pairs, which an eval runner sends before `message`.
- The cases are split by area: waste totals 5, "why" spikes 4, sales 3, breakdowns 3, chart requests 2, CO₂e 2, prep log 1, text waste logging 2, correction 1, no tool 2.
- `args` is a subset match. `outlet_id` is never listed. Items are written as `{item:<menu name>}` and resolved through `generateMockData`, so a generator change does not break the dataset (ADR 0006). `tool: null` means no tool call is right.
- The dataset lives with the copilot app, not in `@sisaku/agents`, because `send_chart` and `propose_waste_entry` are app tools. A test validates every case against the real tool input schemas. Running the model over the dataset and the 90% bar in CI are later work.

## Consequences

- With the menu in context, a data question's first call is the data tool itself, and one round trip is saved. The cost is one `get_menu` call and a few hundred tokens of menu in every turn.
- Chart numbers always match the database, and the model cannot draw what it did not query. Asking for a kind of chart that does not exist means adding a kind in code.
- `vega`, `vega-lite` and `@resvg/resvg-js` (a prebuilt native binary) are new copilot dependencies, and the fonts add about 1.2 MB to the repo.
- Copilot turns without a saved waste guess still write no `agent_runs` row, so for those the version is only in Lens. The eval harness should record the version with each result.
- `list_entries` is capped, so a correction about a busy day may need a narrower filter (item or cause) before the right entry shows up.
