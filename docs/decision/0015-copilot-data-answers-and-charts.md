# 0015: Copilot data answers and charts

- Date: 2026-11-23
- Status: accepted

## Context

ZALS-17 asks the Kitchen Copilot to answer data questions, such as "why did rendang waste spike this week?", with numbers from `query_waste` and `get_sales` and with a chart sent in Telegram. It also asks for the 25 scripted questions of the tool-call correctness eval (technical design), each with the expected first tool call and arguments. Rule 1 of the instructions says every number comes from a tool result, and Lens records no message content (ADR 0012), so a chart must not add numbers the model typed. Two more facts shaped the design. The model needed a `get_menu` call before any item-level question, which would make that call the expected first tool of most eval questions. And nothing tied eval results to the instruction text that produced them. The decisions were grilled in the ZALS-17 session of 2026-11-23.

## Decision

**Instruction versions and their changelog**

- `COPILOT_INSTRUCTIONS_VERSION` covers the instructions and every tool description the model sees. Every change bumps it and adds an entry, newest first, to `packages/agents/INSTRUCTIONS-CHANGELOG.md`. Each entry gives the date, issue, rule text, why, and the eval it should move. A test fails when the newest entry does not match the constant. `AGENTS.md` states the rule.
- Each Copilot trace carries the version as Lens metadata. The `agent_runs` rows the Copilot writes (one per saved waste guess, ADR 0014) store it in the new nullable column `instructions_version` (migration 0004, with a down migration).

## Consequences

- Copilot turns without a saved waste guess still write no `agent_runs` row, so for those the version is only in Lens. The eval harness should record the version with each result.
