# Issue tracker: Multica

Issues and specs for this repo live in the **SisaKu** project of the Multica
workspace **Zalsoft Technology** (`zalsoft-studio`). Use the `multica` CLI for
all operations. Issues are referenced by key (e.g. `ZALS-32`); commands accept a
key or a full UUID.

- Workspace ID: `c4f6176a-3152-46f5-8722-2195788c228e`
- Project ID: `1f2fb8bf-bf7d-4e40-87b7-889dfda9ea3f`

The CLI acts on the current default workspace. Before the first write of a
session, check it with `multica workspace list` (the `*` row must be Zalsoft
Technology), or pass `--workspace-id c4f6176a-3152-46f5-8722-2195788c228e`.
Never write into another workspace (e.g. C3ARBON).

## Agent runs

Multica starts agent runs on some changes. Changing an issue's status or
assignee can start a run. Pass `--no-start` to `multica issue status`, `multica issue update` and
`multica issue assign` unless the user asks for a run.

## Conventions

- **Create an issue**: `multica issue create --project 1f2fb8bf-bf7d-4e40-87b7-889dfda9ea3f --title "..." --description-stdin <<'EOF' ... EOF`. Optional: `--priority`, `--parent <key>`, `--assignee`, `--due-date YYYY-MM-DD`.
- **Read an issue**: `multica issue get <key>`, then `multica issue comment list <key>` for comments.
- **List issues**: `multica issue list --project 1f2fb8bf-bf7d-4e40-87b7-889dfda9ea3f --output json --fields identifier,title,status,priority,labels,description` with `--status`, `--assignee` and `--limit`/`--offset` as needed.
- **Search**: `multica issue search "<text>"`.
- **Make an issue a sub-issue of a parent**: `--parent <parent-key>` on `create`, or `multica issue update <child> --parent <parent-key>` afterwards. List them with `multica issue children <parent-key>`. Use `--stage <n>` only when the parent needs ordered groups of sub-issues.
- **Blocking**: the CLI has no dependency command. Put a `Blocked by: ZALS-n, ZALS-m` line at the top of the blocked issue's description. An issue is unblocked when every blocker's status is `done` or `cancelled`.
- **Comment on an issue**: `multica issue comment add <key> --content-stdin <<'EOF' ... EOF`.
- **Apply / remove labels**: labels are attached by ID. Find it with `multica label list`, then `multica issue label add <key> <label-id>` / `multica issue label remove <key> <label-id>`.
- **Status**: `multica issue status <key> <status> --no-start`. Statuses in use: `backlog`, `done`, `cancelled`.
- **Close**: post the explanation as a comment, then `multica issue status <key> done --no-start` (or `cancelled`). For duplicates: `multica issue status <key> cancelled --duplicate-of <original-key> --no-start`.

Pull requests live on GitHub (`Zalayetha/SisaKu`). List the PRs linked to an
issue with `multica issue pull-requests <key>`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag. PRs live on GitHub, so use the `gh pr` commands for them.)_

## When a skill says "publish to the issue tracker"

Create a Multica issue in the SisaKu project, as in **Create an issue** above.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a sub-issue of the map (`--parent <map-key>`), labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, it is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: `multica issue children <map-key>`, keep the open ones (not `done`/`cancelled`), and drop any with an open blocker or an assignee. The first in map order wins.
- **Claim**: `multica issue assign <key> --to <name> --no-start`. This is the session's first write.
- **Resolve**: post the answer as a comment, then `multica issue status <key> done --no-start`, then append a context pointer (gist + key) to the map's Decisions-so-far.
