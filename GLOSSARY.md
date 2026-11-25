# SisaKu

SisaKu helps commercial kitchens in Indonesia cook the right amount, log what is binned, and report its cost and climate impact.

## Kitchens and people

**Outlet**:
One kitchen location (a restaurant or catering site). Everything a user sees and does is scoped to their one outlet; in the MVP even an owner belongs to exactly one outlet.
_Avoid_: Store, branch, kitchen (when meaning the location)

**Staff**, **Manager**, **Owner**:
The three roles a user has at their outlet. Staff log waste and ask questions; managers and owners can also give approvals.
_Avoid_: Admin, employee

**Kitchen Copilot**:
The conversational agent people talk to on Telegram, in a direct chat. It answers only users registered to an outlet, and acts only when someone messages it.
_Avoid_: Bot, chatbot, assistant

**Nightly pipeline**:
The agent that runs on its own every night per outlet and produces the morning brief. Nobody prompts it; a run can also be started by hand, as for the demo.
_Avoid_: Cron agent, batch job

**Pipeline run**:
One execution of the nightly pipeline for one outlet and one business date, started by the schedule or by hand.
_Avoid_: Job, batch, execution

**Step**:
One of the five parts of a pipeline run, in order: Ingest, Analyze, Forecast, Recommend, Report. Each can be retried alone.
_Avoid_: Stage, task, phase

**Business date**:
The outlet-local day a pipeline run covers. It is fixed when the run is created, and the run forecasts the day after it.
_Avoid_: Run date, today

**Gap**:
Something missing from a business date's data, found by Ingest: no sales, no prep log, no waste logged, or an item sold but not prepped. It is reported and never fails the pipeline run.
_Avoid_: Error, anomaly

**Degraded**:
Said of a step whose attempts ran out and that used its fallback instead, such as the plain baseline forecast. The pipeline run still succeeds.
_Avoid_: Partial, skipped

## Waste

**Waste entry**:
One record of food a kitchen threw away: which menu item, how much (kg, and portions when counted), why, and when.
_Avoid_: Waste log, waste record

**Waste guess**:
What the Kitchen Copilot read from a photo or a text message about binned food, before anyone confirms it. It is shown to the user and never counts in reports.
_Avoid_: Draft, proposal, prediction

**Confirmation**:
A user's tap that turns a waste guess into a waste entry. Any role can confirm; it is not an approval.
_Avoid_: Approval, sign-off

**Waste cause**:
The reason food was thrown away: over-prep, spoilage, plate waste, prep error or expired.
_Avoid_: Reason, category

**Food category**:
The kind of food a menu item is mostly made of (rice, beef, chicken, ...), used to look up its emission factor.
_Avoid_: Category (that is the menu section), food type

## Impact

**Emission factor**:
The kg CO₂e caused per kg of a food category when it is wasted: a production part (growing and making the food) and a landfill part (methane as it rots).
_Avoid_: Carbon factor, emission rate

**CO₂e estimate**:
Waste weight multiplied by its emission factor. Always an estimate: the factors are global defaults, applied to cooked weight.
_Avoid_: Carbon footprint, emissions (without "estimate")

## Donations

**Food bank**:
An organisation that collects surplus food from kitchens and redistributes it. In the MVP the list is fictional mock data.
_Avoid_: Charity, NGO, donation partner

**Pickup request**:
A kitchen's request for a food bank to collect specific menu items and portion counts. It waits for approval before it can be submitted.
_Avoid_: Donation, pickup draft, order

**Approval**:
A manager's or owner's explicit yes to an action the agents proposed, recorded with who gave it. Agents can ask for approval but never give it.
_Avoid_: Confirmation, sign-off (when meaning the recorded decision)
