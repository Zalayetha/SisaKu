# Anvia Lens

Self-hosted Anvia Lens: the tracing backend for the Kitchen Copilot and the nightly pipeline (ADR 0013). It is a Compose project of its own (`sisaku-lens`), separate from the root `docker-compose.yml`, with its own PostgreSQL, ClickHouse and Redis. Only the web UI is published, on `127.0.0.1:8080` by default; the API and databases stay on the private Compose network.

Setup reference: https://docs.anvia.dev/lens/install-and-setup.html

## Start

```sh
cd infra/lens
cp .env.example .env    # set PUBLIC_APP_URL / WEB_ORIGIN, generate each secret with: openssl rand -hex 32
docker compose up -d
curl -fsS http://localhost:8080/health/ready   # {"status":"ready"}
```

`migrate` runs once and must exit 0. If it fails, read `docker compose logs migrate`.

## Get the Copilot keys

1. Open `PUBLIC_APP_URL` (locally http://localhost:8080) and create the first account. It becomes the owner, and public sign-up closes after that.
2. Create a project named `sisaku`.
3. Open **Connect**, create an ingestion key, and copy both keys right away (the secret is shown once).
4. In the repository's root `.env`:

   ```
   ANVIA_LENS_BASE_URL=http://localhost:8080   # the browser origin; no /api suffix
   ANVIA_LENS_PUBLIC_KEY=pk-lens-...
   ANVIA_LENS_SECRET_KEY=sk-lens-...
   ```

## Stop, upgrade, back up

- Stop: `docker compose down`. **Never run `docker compose down -v`**: it deletes every trace and account.
- Upgrade: bump `LENS_VERSION` in `.env`, then run `docker compose pull && docker compose up -d`. Migrations run on start.
- Backups: the volumes are `sisaku-lens_lens-postgres`, `sisaku-lens_lens-clickhouse` and `sisaku-lens_lens-redis`. On the VPS, include them in the same off-host backup as the app volumes (ZALS-27).

## VPS (ZALS-36)

- Set `PUBLIC_APP_URL` and `WEB_ORIGIN` to the same `https://lens.<domain>`, and keep `WEB_PORT=127.0.0.1:8080`.
- Terminate TLS at the host reverse proxy and forward to `127.0.0.1:8080`, keeping the `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers. Set the request body limit to 10m.
- Firewall: only 80 and 443 should be public.

## Differences from the upstream compose file

Based on `anvia-hq/lens` v0.19.0 `docker-compose.yml`, with these changes:

- The project is named `sisaku-lens`, so it can't take over another local Lens project (upstream uses `lens`).
- `LENS_VERSION` is required and `LENS_PULL_POLICY` defaults to `missing`, so a restart never upgrades silently.
- `WEB_PORT` defaults to `127.0.0.1:8080`.
- The `monitor` service is dropped. It bind-mounts the host's `/` and `/proc` to show host metrics in the UI. Lens runs fine without it, and we don't need those metrics.
