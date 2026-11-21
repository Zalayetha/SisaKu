# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one glossary for the whole pnpm workspace.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/decision/`**: technical and architectural decisions (this repo's ADRs). Read the ones that touch the area you're about to work in.
- **`docs/product/`**: product decisions and notes. Read them when the work affects product behaviour or scope.
- `prd.md` and `technical-design.md` at the repo root are the source of truth for what to build and how.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── decision/        ← ADRs: 0001-use-pnpm-workspace.md, ...
│   └── product/         ← product records
├── apps/
└── packages/
```

Write new decision and product records in the format and status rules from `AGENTS.md` (four-digit sequence, `accepted`/`superseeded`/`deprecated`), and add each one to the index there. Don't create `docs/adr/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing decision record, surface it explicitly rather than silently overriding:

> _Contradicts decision 0005 (Drizzle Postgres schema), but worth reopening because…_
