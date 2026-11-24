# 0016: Copilot evals

- Date: 2026-11-24
- Status: accepted

## Context

Every change to the Kitchen Copilot's instructions bumps `COPILOT_INSTRUCTIONS_VERSION` and names "the eval it should move" (ADR 0015), but no eval ran: the 26 tool-call questions were written and schema-checked, and rule 9 was changed in #54 without a measurement. #40 asks for evals of the Copilot (tool-call correctness, 90%; safety, 100%) and of the nightly pipeline (forecast, reports, approval). The pipeline's agents do not exist yet, so their evals wait (#63, #64, #65). The decisions were grilled on 2026-11-24.

## Decision

**What runs**

- `pnpm eval` runs the Copilot evals on `@anvia/core/evals` (`runEvalSuite`, custom metrics), following Carbon Scout's layout (cases, metrics, target, run). The code lives with the copilot app in `apps/copilot/evals/`, next to its datasets, because the turn handler and the local tools live there and `@sisaku/agents` cannot depend on the app. Metrics move into `@sisaku/agents` only when a pipeline eval needs them.
- Each case runs through the real turn handler: the real instructions and tool descriptions, the menu in the turn context, `propose_waste_entry` and `send_chart`, and kitchen-mcp and impact-mcp over in-memory transport. A wrapping observer records every tool call (name and arguments) and the reply. No Telegram is involved.
- The model is the production one (`createModel()`: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_ID`).

**On a throwaway database**

- The runner wipes, migrates and seeds the database at `TEST_DATABASE_URL` with `generateMockData()`, and refuses any database whose name does not end in `_test`. The eval outlet is Warung Rina. The mock data has a manager and a staff member per outlet; the runner adds an owner (`eval-owner`).
- Each case is sent as the user with its role, with its `history` loaded as earlier chat, and the clock pinned to noon on its `today` in the outlet's time zone. A guess is never confirmed, so nothing is saved; `update_entry` is the only tool that writes, and only to this database.

**Scored by code, not a judge**

- Tool-call correctness: the first tool call must be the expected tool, and `expected.args` must match its arguments as a subset (objects may have extra keys; arrays match element by element and have the same length). `{item:<name>}` is resolved through the seeded menu. `tool: null` passes only with no tool call.
- Every check is deterministic, so a given transcript always gets the same verdict and a 100% bar is never decided by a judge's error rate. An LLM judge waits for report faithfulness (#64), where claims need one.
- Bars: tool-call correctness 90%, safety (#61) 100%. Below a bar the run exits 1; a configuration error exits 2; selecting no cases is an error.

**Limits**

- 4 cases at a time, 90 seconds per case; a timed-out case fails with reason "timeout". One run per case by default; `--repeat N`, `--dataset` and `--case` are for local work.

**Results**

- The terminal shows passed/total per dataset and area, and every failed case with the expected and actual call. A JSON result is written to `apps/copilot/evals/results/` (git-ignored), with every case's calls and reply, tagged with the instructions version, the instructions fingerprint (`copilotInstructionsFingerprint()`, the value the changelog pins), the model id, the date and the commit. A case that could not be scored (a timeout or a turn error) has outcome `invalid` in the JSON and counts as failed.

**Lens, when configured**

- With all three `ANVIA_LENS_*` settings, each case is traced to Lens under the service name `sisaku-copilot-eval`, never `sisaku-copilot`, with an `eval` tag and `eval_case`, `eval_dataset`, `instructions_version` and `model` metadata, and its score is attached to its trace through `lens.evalReporter()`. Eval traces use full capture: they hold only mock data and scripted messages, and a trace without content cannot explain a failure. Production stays in safe capture (ADR 0012).
- Without Lens the eval runs the same. A failing Lens observer is dropped for that case and noted in its errors, and the run warns when cases went untraced or scores did not reach Lens; scores never depend on Lens.

**Running it locally**

- Start the test database (for example `postgres:16.6-alpine` with database `sisaku_test`) and, if wanted, Lens (ADR 0013). Set `TEST_DATABASE_URL` and `LLM_API_KEY` (the script loads the root `.env` if present), then run `pnpm eval`, optionally with `--case <id>` or `--repeat 3`.

**CI waits for Lens on the VPS**

- An `eval` job in GitHub Actions (#62) will run on pushes and pull requests that touch what the Copilot runs, write the score to the job summary, and skip with a notice while `LLM_API_KEY` is not a repository secret. The maintainer chose to add it after Lens moves to the VPS (#67), so CI runs can trace there too. The eval scores without Lens, so this is a choice of order, not a dependency.

## Consequences

- A prompt change can be measured before it ships: run `pnpm eval --repeat 3` before and after, and compare scores for the two instruction versions.
- Each run costs model calls (26 turns for tool-call correctness), and model output varies, so a single run is noisy; repeats are for deliberate prompt work.
- Until #62, a regression shows only when someone runs the eval.
- The eval exercises only text messages; photo guesses and confidence calibration are not covered.
- Turn handler tests and evals share their in-process MCP servers and fakes (`src/testing/harness.ts`).
