# 0003: Use root Playwright tests

- Date: 2026-11-19
- Status: accepted

## Context

Browser end-to-end tests are needed for the future dashboard and any flows that span the app. The MVP has no web UI yet (the dashboard is P1 and Telegram is the only interface), so there is nothing to test in a browser today.

## Decision

Playwright tests live in `e2e/` at the repository root, not inside an app. `playwright.config.ts` is also at the root. Run them with `pnpm test:e2e`. Chromium is the only browser project for now.

The placeholder spec in `e2e/smoke.spec.ts` is skipped until a UI exists. It stays in place so the CI job has a real test to run, and so Playwright does not fail with "no tests found".

## Consequences

- One Playwright configuration for the whole repository, instead of one per app.
- The CI e2e job installs Chromium before it runs. This adds time to CI, so it is a separate job.
- When the UI lands, the skipped smoke test should be replaced with a real test in the same change.
