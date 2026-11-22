# 0013: Self-host Anvia Lens as a separate Compose project

- Date: 2026-11-22
- Status: accepted

## Context

The Kitchen Copilot refuses to start without the three `ANVIA_LENS_*` settings (ADR 0012), and the nightly pipeline will trace to the same place. Anvia Lens is distributed only as a self-hosted Docker Compose stack: api, worker, web and a one-shot migrate service, with their own PostgreSQL, ClickHouse and Redis. The Carbon Scout Platform repository already runs it from `infra/lens/docker-compose.yml`.

## Decision

- Run Lens ourselves from `infra/lens/`, a Compose project named `sisaku-lens`, separate from the root `docker-compose.yml` (app infrastructure) and from the app deploy stack (ZALS-27). Lens has its own databases and upgrade cadence, and keeping it separate means `docker compose down` on one stack never touches the other.
- Use upstream's compose file at a pinned release (`LENS_VERSION=0.19.0`, pull policy `missing`). Don't use `latest`, so a restart never upgrades silently.
- Publish only the web UI, on `127.0.0.1:8080`. On the VPS, the host reverse proxy serves it over HTTPS on its own subdomain. The API and the three databases stay on the private network.
- Drop upstream's `monitor` service. It bind-mounts the host's `/` and `/proc` for host metrics, which we don't need, and Lens runs without it.
- Use the same setup locally and on the VPS; only `PUBLIC_APP_URL`, `WEB_ORIGIN` and the secrets differ.

## Consequences

- Developers can run a real Lens locally, so the Copilot's fail-fast startup (ADR 0012) does not block local testing.
- We operate one more stateful service. Its three volumes must be in the VPS backup, and `docker compose down -v` destroys all traces.
- Upgrades are a manual bump of `LENS_VERSION`. Read the Lens release notes first, since `migrate` runs on start.
- Ingestion keys are created by hand in the Lens UI, and the secret is shown once. Changing `INGESTION_KEY_PEPPER` invalidates every key.
