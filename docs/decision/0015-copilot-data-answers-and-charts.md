# 0015: Copilot data answers and charts

- Date: 2026-11-23
- Status: accepted

## Context

ZALS-17 asks the Kitchen Copilot to answer data questions, such as "why did rendang waste spike this week?", with numbers from `query_waste` and `get_sales` and with a chart sent in Telegram. It also asks for the 25 scripted questions of the tool-call correctness eval (technical design), each with the expected first tool call and arguments. Rule 1 of the instructions says every number comes from a tool result, and Lens records no message content (ADR 0012), so a chart must not add numbers the model typed. Two more facts shaped the design. The model needed a `get_menu` call before any item-level question, which would make that call the expected first tool of most eval questions. And nothing tied eval results to the instruction text that produced them. The decisions were grilled in the ZALS-17 session of 2026-11-23.

## Decision

**The menu is in the turn context**

- Each turn reads the outlet's menu once and puts its names and ids in the instructions' turn context. Rule 8 now says "call propose_waste_entry" instead of "call get_menu, then propose_waste_entry", and `propose_waste_entry` uses the same menu. `get_menu` stays available for cost, weight and food category.

**"Why" questions follow a fixed recipe**

- Rule 10: call `query_waste` grouped by day for the item over the period asked plus the 14 days before it, then `get_sales` for the same item and days, and compare. A cause is named only as "likely", and only when the data shows it (a sales drop or a change of waste cause). At most 5 tool calls for one question. This mirrors the nightly pipeline's Analyze step.

**Instruction versions and their changelog**

- `COPILOT_INSTRUCTIONS_VERSION` covers the instructions and every tool description the model sees. Every change bumps it and adds an entry, newest first, to `packages/agents/INSTRUCTIONS-CHANGELOG.md`. Each entry gives the date, issue, a fingerprint of the instructions text, rule text, why, and the eval it should move. A test fails when the newest entry's version does not match the constant, or when its fingerprint (SHA-256 of `COPILOT_INSTRUCTIONS`, first 16 hex characters) does not match the current text, so an instruction edit without a new version cannot pass. Tool descriptions are not fingerprinted; their bumps stay by hand. `AGENTS.md` states the rule.
- Each Copilot trace carries the version as Lens metadata. The `agent_runs` rows the Copilot writes (one per saved waste guess, ADR 0014) store it in the new nullable column `instructions_version` (migration 0004, with a down migration).

## Consequences

- With the menu in context, a data question's first call is the data tool itself, and one round trip is saved. The cost is one `get_menu` call and a few hundred tokens of menu in every turn.
- Copilot turns without a saved waste guess still write no `agent_runs` row, so for those the version is only in Lens. The eval harness should record the version with each result.
