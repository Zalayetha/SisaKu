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

- A run is one BullMQ Flow on the queue `nightly-pipeline`: Report is the root and Ingest the deepest child, all added together. A step that enqueued the next one would leave a gap between "done" and "next enqueued" for a crash to land in. A step's job carries only the run id and the step name, and its id is derived from them.
- The run is written to Postgres first, then queued. A run in progress whose jobs are not in Redis is queued again when its creation is repeated; a step that already has a result returns without running.
- BullMQ 6 on Redis, with `ioredis`, pinned to exact versions. Concurrency 2. Finished jobs stay in Redis for 14 days; Postgres keeps the history.

**Steps**

- A step is a name, an output schema and a run function, with an optional fallback and time limit. The run function gets the run, the validated outputs of earlier steps, the MCP servers, the trace options, an abort signal, and `onSave` for its own rows. Queue code does not change when a stub is replaced.
- A step saves its own rows through `onSave`, in the transaction that saves its result and status, so they are saved together or not at all. It deletes the run's earlier rows first.
- Ingest (#78) reads the menu, sales, prep log and waste of the business date through kitchen-mcp, without an LLM, and saves totals and gaps, not the rows: later steps read the details through the MCP tools. Gaps (`no_sales`, `no_prep_log`, `no_waste_logged`, `sold_not_prepped` per item) never fail the step; a failed read does. A record of zero portions is not a missing record, and a missing prep log is reported once instead of for every item sold.
- The Report step writes the brief and never sends it. Sending is a separate job (#39).

**Retries (#79)**

- A step gets 4 attempts, with 30, 60 and 120 seconds after a failed one, and 5 minutes per attempt unless it sets its own limit. At the limit its abort signal fires and the attempt fails, whether or not the step listens; what it returns later is dropped. The limit covers the step's work, not the save after it.
- Between attempts the step is `pending` in Postgres, with the attempts made and the last error on it. The error stays when a later attempt succeeds, to show why it took more than one. `failed` is recorded only when BullMQ will not try again.
- A `PermanentError` ends the attempts at once: a run or job record that does not exist, job data that is not a run and a step, or an earlier output that is missing or no longer matches its schema. Steps may throw it too. Output that breaks the step's own schema is an ordinary failure, because an LLM may do better next time.
- When its attempts have run out, by failing, by kills or by a permanent error, a step with a fallback saves the fallback's output and is degraded, and the run still succeeds. The fallback has the same time limit and schema. Without one, or when it fails too, the job and the run are failed and the later steps wait.
- Retrying a failed job by hand puts its run back in progress, and the run continues from that step. Its attempts count anew, but BullMQ makes only one more on its own after four failed ones.
- A killed worker's step is taken over within a minute. A kill uses up an attempt, as a failure does. BullMQ would by default fail a job at its second kill without calling our code, which could not then use the fallback, so its limit is lifted and the step's record counts every start. A step interrupted on its 4th attempt is not started again: only its fallback is left. A job killed 8 times does not get that either, in case the fallback is what kills the worker.
- A step that reached its fallback earlier, by a permanent error or after a retry by hand, runs again if its worker is killed during the fallback, within its 4 attempts. The record does not say that its attempts had run out. This is harmless, because a step saves only through `onSave`, with its result.
- The record names its current attempt by its start time, and only that attempt may save, use the fallback, or record a failure. A worker thought dead that finishes late changes nothing.

**Schedule (#81)**

- One BullMQ job scheduler per outlet at 22:00 in its timezone, on the same queue. Its job, `start`, creates the run. The business date is the local day of the scheduled time, in the timezone the start was scheduled in, never of the current time.
- A missed night is useful until 06:00 outlet time. A start taken up later is skipped and logged. One for a night that is no longer the latest is skipped too, and the latest is caught up instead: after an outage BullMQ starts the oldest missed night, and schedules the next one only after that.
- A start that fails, as when Postgres is down, is tried every minute for 8 hours, so until the night is too late. One promoted by hand before its time goes back to wait, because it would take tonight's place; `pnpm pipeline:run` starts a run at any time.
- When it starts, the worker makes the schedulers match the outlets table, then catches up each outlet's latest 22:00 by the same rule. If it cannot, it does not start. An outlet with an invalid timezone is logged and has no schedule. Outlets changed while the worker runs are picked up at its next start.
- Updating a BullMQ scheduler drops its pending start, even one that is overdue or already waiting for a worker (checked on BullMQ 6.7.7 with a real Redis). So the sync leaves unchanged schedulers alone. A timezone change does replace the pending start; catch-up covers the night if it was missed.
- A scheduled run is created once per outlet and date, whatever its status: a failed one is not started again by itself. A manual run for that date does not block it.

**Tracing (#80)**

- One Lens trace per run. Its id is generated and stored when the run is created, so every attempt of every step joins it, whichever worker runs it. Each step attempt is a root span of that trace, made with Anvia's pipeline observer (`pipeline.<step>`), also when the step calls no LLM. A run-level span would have to stay open across processes, so there is none. Lens shows the five root spans as one trace (checked by hand on a local Lens, 2026-11-25).
- A span is labelled with agent, run id, outlet id, business date, step and attempt, and never with a name. It ends when the attempt's result is saved, and covers the fallback too: a degraded step's last span carries the error that degraded it.
- A step gets `trace` and `observability` in its context and passes both to the agents it runs, which nests them under the attempt's span.
- `safe` capture, under the service name `sisaku-pipeline`. It keeps error messages, and a failed query's message has the values it would have saved, so those are cut off in Lens, for steps and the agents they run, as are the keys and personal contacts Anvia's default patterns find; `pipeline_jobs.error` keeps the whole message. The rest is sent as it is, so steps must not put names or numbers of the business in an error. `cost_usd` stays empty.
- Lens is best effort. Its errors are logged, a span's start is waited for at most 200 ms (without its id, agents join the trace but are not nested), and its end is not waited for. An agent does wait for its own observer, which Lens's client serves without the network. On shutdown the spans of steps left behind are cancelled, and telemetry is flushed within 5 seconds.

**Boundaries**

- As in ADR 0012, "agents reach data only through tools" binds the LLM, not fixed code. Kitchen data is read through MCP tools; runs, jobs and results are written by fixed code through `@sisaku/db`. No MCP write tools are added.
- `apps/worker` holds the queue and the step engine, and runs from source through tsx like the Copilot, so it drops the tsup build of ADR 0004. LLM steps will live in `packages/agents`.
- The worker refuses to start when Redis, Postgres, either MCP connection or the Lens settings are missing or broken. Lens itself is not contacted, because an outage must never stop a run. On SIGTERM it waits up to 30 seconds for the current steps.
- Bull Board is the operators' dashboard, in `apps/api` so it outlives a killed worker (#82, below).

**Bull Board (#82)**

- The ready-made `@bull-board` packages on a Hono server, no dashboard of our own. `apps/api` runs from source through tsx and drops the tsup build of ADR 0004, like the worker. It takes the queue's name and settings from `@sisaku/worker/queue` and `/settings`, so both always use the same queue.
- Basic auth in front of every route, static files included, with one operator account. It refuses to start without a password. Requests from another website are refused too, because the browser sends the saved password with them (Hono's CSRF check; Bull Board itself takes any content type).
- It listens on 127.0.0.1 unless `API_HOST` is set. On the VPS (#42) the container sets `API_HOST=0.0.0.0` and its port is published to the host's loopback only (`127.0.0.1:3003:3003`), reached through an SSH tunnel. A proxy that rewrites the host name must keep HTTPS, or the CSRF check refuses actions.
- Retrying a failed job there resumes its run. Bull Board can also pause, add, promote, delete and obliterate. The worker checks every job it takes, so a job added by hand with other data fails; an obliterated queue loses its jobs, and gets its schedules back when a worker starts. A schedule edited there (its time, data, an end date or a limit) is put back at the next worker start too, and until then follows the edit.

## Consequences

- Spans are sent when they end, in batches of up to 5 seconds. A killed worker (SIGKILL) therefore loses the span of the attempt it was running, and of any that ended in those seconds. `pipeline_jobs` has the real number of attempts. A step interrupted on its 4th attempt has a second span numbered 4, for its fallback.
- Redis can be emptied without losing finished work: the run's state is in Postgres, and repeating `pnpm pipeline:run` queues the rest.
- A worker thought dead may still finish its step. Its result is dropped even if the replacement has not finished.
- A step that ignores its abort signal may still be running when its retry starts. Its result and rows are dropped, but not what it did elsewhere, so steps must pass the signal on and change nothing outside `onSave`.
- Retrying an old failed job is allowed while a newer run of the same outlet and date is in progress. Both finish, and readers use the latest successful one.
- BullMQ decides when a step has failed; the worker then records it. If that record is lost (Postgres was down), the run looks in progress until `pnpm pipeline:run` is repeated, which records the failure and starts a new run. For a scheduled run, a worker started before 06:00 records it too, without a new run.
- A crash between Postgres and Redis leaves a run in progress without jobs until its creation is repeated. For a scheduled run that is the next try of its start, or a worker start, before 06:00.
- `agent_runs.outlet_id` references `outlets`, so the mock-data reset (ADR 0006, amended) now empties `agent_runs` too, Copilot rows included. The rows pointing at them were already emptied by it.
- Tests run on real Redis (`TEST_REDIS_URL`) and Postgres, under a key prefix of their own, and skip without them. CI has both.
