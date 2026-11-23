# Issue tracker: GitHub Issues

Issues and specs for this repo live in GitHub Issues on `Zalayetha/SisaKu`. Use
the `gh` CLI for all operations. Issues are referenced by number (e.g. `#32`).

## Old `ZALS-*` keys

Until 2026-11-23 issues lived in Multica with `ZALS-*` keys, and older ADRs,
commits and PRs still use them. Every Multica issue was moved with its
description and comments; the GitHub title keeps the key, e.g.
`[ZALS-17] ...`. For ZALS-9 to ZALS-36, the issue number is the key plus 15
(ZALS-17 is #32). Find one with `gh issue list --search "ZALS-17 in:title" --state all`.
Multica is no longer updated.

## Mentions

GitHub notifies anyone written as a bare `@name` in an issue or comment. Write
roles, placeholders and package names (`@types/node`, `@anvia/core`) in
backticks.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file - <<'EOF' ... EOF`. Optional: `--label`, `--assignee`, `--milestone`.
- **Read an issue**: `gh issue view <n> --comments`.
- **List issues**: `gh issue list --state open --json number,title,labels,body` with `--label`, `--assignee`, `--search` and `--limit` as needed.
- **Search**: `gh issue list --search "<text>" --state all`.
- **Sub-issues**: link a child under a parent with `gh api -X POST repos/Zalayetha/SisaKu/issues/<parent>/sub_issues -F sub_issue_id=<child id>`, where the child id is `gh api repos/Zalayetha/SisaKu/issues/<child> --jq .id` (the database id, not the number). List them with `gh api repos/Zalayetha/SisaKu/issues/<parent>/sub_issues --jq '.[].number'`.
- **Blocking**: put a `Blocked by: #n, #m` line at the top of the blocked issue's body. An issue is unblocked when every blocker is closed.
- **Comment on an issue**: `gh issue comment <n> --body-file - <<'EOF' ... EOF`.
- **Apply / remove labels**: `gh issue edit <n> --add-label <name>` / `--remove-label <name>`.
- **Priority**: one of the labels `priority:high`, `priority:medium`, `priority:low`.
- **Status**: open issues are the backlog. There is no separate status field.
- **Close**: post the explanation as a comment, then `gh issue close <n> --reason completed` (or `--reason "not planned"`). For duplicates: `gh issue close <n> --reason duplicate --duplicate-of <original>`. A PR body with `Closes #n` closes the issue when it merges.

## Automation

The Pullfrog app runs its workflow whenever an issue is opened, and comments on
the issue. Expect one bot comment on every new issue.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag. Use the `gh pr` commands for them.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue, as in **Create an issue** above.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: one issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a sub-issue of the map (see **Sub-issues**), labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, it is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's sub-issues, keep the open ones, and drop any with an open blocker or an assignee. The first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee <login>`. This is the session's first write.
- **Resolve**: post the answer as a comment, then `gh issue close <n> --reason completed`, then append a context pointer (gist + number) to the map's Decisions-so-far.
