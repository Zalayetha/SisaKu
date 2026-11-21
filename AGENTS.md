# Project documentation

## Structure

```text
docs/
├── decision/
│   └── 0001-use-pnpm-workspace.md
├── product/
│   └── 0001-product-direction.md
└── README.md
```

- `decision/`: technical and architectural decisions, their reasoning, and consequences.
- `product/`: product decisions and supporting notes.

Name documents `xxxx-meaningful-name.md`, using a four-digit sequence and a short
kebab-case description. Start at `0001` in each directory and increment
independently. Keep existing numbers and filenames stable so links remain valid.

## Decision records

Each decision has exactly one status:

| Status        | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `accepted`    | The decision is in effect.                                          |
| `superseeded` | A newer decision replaces this one. Link to the replacement.        |
| `deprecated`  | The decision no longer applies, without a replacement. Explain why. |

Preserve old records. When replacing a decision, create a new accepted record,
mark the old one `superseeded`, and link the two records. When deprecating a
decision, record the date and reason in the old document.

Use this format for new decisions:

```markdown
# XXXX: Meaningful decision title

- Date: YYYY-MM-DD
- Status: accepted

## Context

What problem or constraint requires a decision?

## Decision

What did we choose, and why?

## Consequences

What benefits, tradeoffs, or follow-up work does this create?
```

## Product records

Keep product decisions and notes together for a specific topic. Record agreed
choices under **Product decision**. Keep observations, ideas, assumptions, and
open questions under **Notes**, so they are distinguishable from decisions.
Product records do not use the technical decision status field.

```markdown
# XXXX: Meaningful product topic

- Date: YYYY-MM-DD

## Product decision

What has been agreed, who is it for, and why?
If nothing has been decided, say so explicitly.

## Notes

Supporting context, ideas, assumptions, and open questions.
```

## Index

### Decisions

- [0001: Use a pnpm workspace](decision/0001-use-pnpm-workspace.md)
- [0002: Use Oxlint, Oxfmt, and Husky](decision/0002-use-oxlint-oxfmt-and-husky.md)
- [0003: Use root Playwright tests](decision/0003-use-root-playwright-tests.md)
- [0004: Use tsup as the bundler and Bundler module resolution](decision/0004-use-tsup-bundler-with-bundler-resolution.md)
- [0005: Use Drizzle for the Postgres schema, with hand-written down migrations](decision/0005-use-drizzle-postgres-schema-with-sql-migrations.md)
- [0006: Use a seeded, deterministic mock-data generator](decision/0006-use-seeded-mock-data-generator.md)
- [0007: Import sales, prep logs and menu from CSV through `@sisaku/db`](decision/0007-use-csv-import-in-db-package.md)
- [0008: Enforce outlet and item pairing with composite foreign keys](decision/0008-use-composite-foreign-keys-for-outlet-item-pairing.md)

### Product

- [0001: Product direction](product/0001-product-direction.md)

Add a link here whenever a document is created.

## Agent skills

### Issue tracker

Issues live in the Multica project "SisaKu" (workspace Zalsoft Technology, `ZALS-*` keys), managed with the `multica` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each named after its role (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md`, with decisions in `docs/decision/`. See `docs/agents/domain.md`.
