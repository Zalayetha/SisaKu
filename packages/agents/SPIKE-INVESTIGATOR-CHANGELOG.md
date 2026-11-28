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

## 2026-11-27.2

- Date: 2026-11-27
- Issue: #93 (ADR 0018)
- Fingerprint: `1837f1d74c37d964`
- Changed, kinds: "Usual" is the same weekday in the weeks before. `sales_drop` is "sold clearly
  fewer portions than on a usual day (a fifth fewer or more) … Choose it when sales fell that much,
  even if prep also rose a little"; `over_prep` needs prep clearly above a usual day while sales
  stayed about as usual.
- Changed, rule 1: the plan is get_sales from 14 days before through the business date, and
  get_prep_log for the business date and a usual day.
- Added, rule 2: "Compare the business date with the usual days, never with the day before: demand
  differs by weekday."
- Added, rule 3: "The cause staff recorded on each waste entry is not the explanation: "over_prep"
  there only means food was left over, whatever the reason. Use causes to tell spoilage from
  leftover food, never as the evidence for sales_drop or over_prep; base those on the sales and
  prep numbers."
- Changed prompt: names the business date's weekday and the two same weekdays before it to
  compare with.
- Why: the first manual run with a real model, on Nyepi (2026-03-19, Warung Rina, mock data),
  explained all three spikes as `over_prep`. Its evidence was the staff-recorded cause ("entirely
  classified as over_prep") and prep against the day before (98 against 87), while Nasi Putih sold
  56 against 80 to 85 on usual Thursdays.
- Eval to move: none yet (#90). Manual check: the same run should name `sales_drop` for Nasi
  Putih, with evidence from sales and prep numbers.

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
