# 0018: Analyze step finds and explains waste spikes

- Date: 2026-11-26
- Status: accepted

## Context

Analyze is the second step of the nightly pipeline (ADR 0017, issue #35). It groups the business date's waste by item and cause, and for any menu item above double its 14-day average it finds out why, so the morning brief can name waste spikes with a likely explanation. The technical design limits it to 5 tool calls per item. A whole-menu event such as a holiday can make most items spike at once, and the LLM may fail on any night. The decisions were grilled on 2026-11-26. Terms (**Waste spike**, **Spike explanation**) are in `GLOSSARY.md`.

## Decision

**Fixed code finds the spikes, an LLM only explains them**

- The step reads the business date's waste by item and by cause, and each item's waste over the 14 days before, through `query_waste` from fixed code, as Ingest does. Deciding what a spike is takes no LLM, so it is deterministic and tested exactly, and a night without a spike makes no LLM call.
- An item is a waste spike when its waste on the business date is more than twice its daily average **and** at least 1 kg. The average counts only days in the 14 before that have a sales record, with no waste counting as 0 kg; with fewer than 7 such days there is too little history and nothing is flagged. Counting closed or unlogged days as 0 would lower the average and make false spikes, as would dividing a new outlet's few days by 14.

**One investigation per spike, at most three a night**

- The 3 spikes with the most kg are investigated, one after another. The others are reported with `investigated: false` and an `unexplained` explanation. A holiday can flag most of the menu, and ten investigations would cost ten agent runs for ten near-identical explanations.
- Each investigation is its own agent run, the spike investigator, given the spike's numbers in its prompt and four tools scoped to the outlet: `get_sales`, `get_prep_log`, `query_waste`, `list_entries`. One run per spike matches the limit of 5 tool calls per item exactly; one run for all spikes would let one item take another's budget.
- The 6th tool call of an investigation is refused, without reaching kitchen-mcp, with a message to answer from what it has. An agent that still gives no explanation leaves the spike `unexplained`.
- An explanation has a kind (`sales_drop`, `over_prep`, `spoilage`, `unexplained`) and a short English sentence with the numbers it read. Report writes the Indonesian brief from it. It is never called a cause: a waste cause is what staff record on each entry, and a spike of over-prep entries can be explained by a sales drop.
- `search_knowledge` is left out until RAG exists (D10). A stub would spend the 5 calls on nothing.

**Failure and storage**

- An investigation that throws fails the whole attempt, so the step's 4 attempts (ADR 0017) start over rather than saving some explanations and dropping others. Reaching the call limit is not a failure.
- The fallback saves what fixed code computed, with every spike `unexplained`. The step is degraded and the run goes on: a brief that lists spikes without explanations beats no brief.
- The output (waste by item, waste by cause, spikes) is JSON in `pipeline_job_results` only. No table: nobody edits spikes, nothing points at them, and a weekly report can read the last 7 Analyze results.

**Code and instructions**

- The spike investigator lives in `packages/agents`, the step in `apps/worker`. The step is built with the model it uses, so tests pass a scripted model; the worker builds the real one at start and refuses to start without `LLM_API_KEY`.
- The investigator's instructions have their own version, fingerprint test and changelog, apart from `COPILOT_INSTRUCTIONS_VERSION`. The two agents change for different reasons and are judged by different evals; a shared number would show Copilot changes that did not happen.

## Consequences

- The 2× threshold, 1 kg floor, 7 days and top 3 are numbers in code, not in the prompt, and can change without an instructions version.
- A night with many spikes still makes at most 3 investigations of up to 5 tool calls each per attempt; across 4 attempts the worst case is 60 tool calls.
- Tests use a fixture and a scripted model, so they prove the plumbing, not that a real LLM explains well. An eval with known answers, checking that every number in an explanation came from a tool result, is follow-up work.
- The mock-data generator plants no waste spike on purpose. Its holidays (demand down, prep as usual) and the week after a demand spike (prep from an inflated week) produce real ones for the demo.
