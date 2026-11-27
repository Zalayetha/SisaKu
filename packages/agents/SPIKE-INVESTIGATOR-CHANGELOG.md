# Spike investigator instructions changelog

Every change to the spike investigator's instructions (`src/spike-investigator.ts`), or to its
prompt or tool list, bumps `SPIKE_INVESTIGATOR_INSTRUCTIONS_VERSION` and adds an entry here,
newest first. It is apart from the Copilot's version and changelog (ADR 0018): the two agents
change for different reasons and are judged by different evals. Each investigation's Lens trace
records the version.

Each entry gives: date, issue, the fingerprint of the instructions text, what was added, changed
or removed, why, and the eval it should move. A test checks that the newest entry's version equals
the constant and that its fingerprint (the first 16 hex characters of the SHA-256 of
`SPIKE_INVESTIGATOR_INSTRUCTIONS`) matches the current text, so an edit without a new version
fails; the failure message prints the new fingerprint. The prompt and tool descriptions are not
fingerprinted: bump the version for those by hand.

## 2026-11-27.1

- Date: 2026-11-27
- Issue: #93 (ADR 0018)
- Fingerprint: `83b05f4aebb57be4`
- Added: the first instructions. The investigator explains one waste spike as `sales_drop`,
  `over_prep`, `spoilage` or `unexplained`, with one English sentence of evidence whose numbers
  come from tool results; it may make at most 5 tool calls (`get_sales`, `get_prep_log`,
  `query_waste`, `list_entries`), and answers with a JSON object only.
- Why: Analyze names waste spikes with a likely explanation for the morning brief (#35).
- Eval to move: none yet. An eval with known answers, checking every number in the evidence came
  from a tool result, is follow-up work (#90).
