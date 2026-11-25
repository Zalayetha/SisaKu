# 0017: Nightly pipeline on BullMQ

- Date: 2026-11-25
- Status: accepted

## Context

The nightly pipeline (#34, spec #76) runs five steps per outlet at 22:00: Ingest, Analyze, Forecast, Recommend, Report. A failed or killed step must be retried alone with the outputs of earlier steps kept, and everything a run produces must point at one `agent_runs` row and one Anvia Lens trace. `agent_runs` had no outlet, date or finish time, and nothing stored a step's output. The decisions were grilled on 2026-11-25. They are built in parts: #77 (runs, steps, manual trigger), #78 (Ingest), #79 (retries), #80 (trace), #81 (schedule), #82 (Bull Board).

## Decision

**Runs and steps in Postgres**

- A pipeline run is one `agent_runs` row for one outlet and one business date, with agent `nightly-pipeline` and trigger `schedule` or `manual`. `outlet_id`, `business_date`, `finished_at` and `error` are empty for Copilot rows. `cost_usd` stays empty: Lens records cost.
- The business date is fixed when the run is created and never recomputed, so a retry after midnight still belongs to the same day.
- `pipeline_jobs` holds the state of each step and `pipeline_job_results` its output, as in CritiqueQ's `Job` and `JobResult`. Unlike CritiqueQ, the result and the status are saved in one transaction, and the output is one JSON column because each step has its own shape, checked against the step's Zod schema before it is saved and again after a round trip through JSON, so a step fails itself rather than the one that reads it.
- A step gets a table of its own only when people change its rows, other rows point at it, or its fields are queried across many nights. Its result is then a summary, so no number is stored twice.
- A unique index allows one scheduled run per outlet and business date. Manual runs may repeat, one at a time. Readers use the latest successful run.

**Jobs in BullMQ**

- A run is one BullMQ Flow on the queue `nightly-pipeline`: Report is the root and Ingest the deepest child, all added together. A step that enqueued the next one would leave a gap between "done" and "next enqueued" for a crash to land in. Jobs carry only the run id and the step name, and their ids are derived from them.
- The run is written to Postgres first, then queued. A run in progress whose jobs are not in Redis is queued again when its creation is repeated; a step that already has a result returns without running.
- BullMQ 6 on Redis, with `ioredis`, pinned to exact versions. Concurrency 2. Finished jobs stay in Redis for 14 days; Postgres keeps the history.

**Steps**

- A step is a name, an output schema and a run function, with an optional fallback and time limit. The run function gets the run, the validated outputs of earlier steps, the MCP servers, the trace options and an abort signal. Queue code does not change when a stub is replaced.
- A step that uses its fallback is degraded and the run still succeeds. Without a fallback the run stops as failed. (The retries and the fallback are built in #79.)
- The Report step writes the brief and never sends it. Sending is a separate job (#39).

**Boundaries**

- As in ADR 0012, "agents reach data only through tools" binds the LLM, not fixed code. Kitchen data is read through MCP tools; runs, jobs and results are written by fixed code through `@sisaku/db`. No MCP write tools are added.
- A trace id is generated and stored when the run is created, so every step and retry can join one trace.
- `apps/worker` holds the queue and the step engine, and runs from source through tsx like the Copilot, so it drops the tsup build of ADR 0004. LLM steps will live in `packages/agents`.
- The worker refuses to start when Redis, Postgres, either MCP connection or the Lens settings are missing or broken. Lens itself is not contacted, because an outage must never stop a run. On SIGTERM it waits up to 30 seconds for the current steps.
- Bull Board is the operators' dashboard, in `apps/api` so it outlives a killed worker (#82).

## Consequences

- Redis can be emptied without losing finished work: the run's state is in Postgres, and repeating `pnpm pipeline:run` queues the rest.
- A worker thought dead may still finish its step. What was recorded first stands, a result or a failure, and the late one is dropped.
- BullMQ decides when a step has failed; the worker then records it. If that record is lost (Postgres was down), the run looks in progress until `pnpm pipeline:run` is repeated, which records the failure and starts a new run.
- A crash between Postgres and Redis leaves a run in progress without jobs until its creation is repeated.
- `agent_runs.outlet_id` references `outlets`, so the mock-data reset (ADR 0006, amended) now empties `agent_runs` too, Copilot rows included. The rows pointing at them were already emptied by it.
- Tests run on real Redis (`TEST_REDIS_URL`) and Postgres, under a key prefix of their own, and skip without them. CI has both.
