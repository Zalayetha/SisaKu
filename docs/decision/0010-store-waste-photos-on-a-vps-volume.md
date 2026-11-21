# 0010: Store waste photos on a VPS Docker volume

- Date: 2026-11-21
- Status: accepted

## Context

Staff log waste by sending a photo to the Telegram bot. The `waste_entries.photo_url` column assumed photos would live at a URL, but nothing stores them. The Telegram download URL from `getFile` contains the bot token and expires after about an hour, so it must never be saved. The photo is read by the vision model in the Copilot before `log_waste` is called; `kitchen-mcp` only needs to record where the photo is. The web dashboard (F7) is out of scope, so nothing displays photos.

Options considered: keep only the Telegram `file_id`; save files to the VPS disk; upload to object storage (R2, S3, MinIO); store bytes in Postgres. Postgres was ruled out because it bloats the database and its backups. Object storage needs a new account, keys and code, and only pays off when something shows photos in a browser.

## Decision

- Photos are saved as files in a named Docker volume (`photos-data`) on the VPS, mounted into the service that receives them. A volume, not the container filesystem, so files survive container rebuilds and redeploys.
- The Telegram side (ZALS-16) downloads the photo and writes it to the volume. `kitchen-mcp` never downloads, reads or stores image files.
- The database stores a path relative to the volume root, such as `<outlet_id>/<entry-uuid>.jpg`, so it does not depend on where the volume is mounted. `log_waste` takes it as `photo_path` and rejects absolute paths, `..` segments and URLs.
- Until the column is renamed, the path is stored in the existing `photo_url` column.

## Consequences

- Follow-up in ZALS-16: save photos to the volume, rename `photo_url` to `photo_path` (migration plus hand-written down migration, ADR 0005), and replace mock-data's `mock://photos/...` values.
- Follow-up in ZALS-27: add the `photos-data` volume to Docker Compose and include it in backups. Without backups, photos are lost if the VPS is lost.
- Disk use grows with every photo; a retention rule may be needed after the MVP.
- If a dashboard returns, move to object storage and upload the existing files from the volume.
