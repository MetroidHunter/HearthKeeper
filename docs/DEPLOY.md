# Deploying HearthKeeper

All deploy tasks are targets in the top-level `Makefile`; `make help` lists them. The box needs `make` (`sudo apt-get install -y make`).

| Target | Where | What it does |
|---|---|---|
| `sudo make bootstrap` | box | Idempotent install and update: Node 22, Caddy (automatic TLS), swap, service user, `npm ci` + build, systemd service, health checks. Asks for the domain, Google client ID and allowed emails if it does not know them, and remembers them in `/etc/hearthkeeper.env`. |
| `sudo make update` | box | `git pull` this checkout (as its owner), then `bootstrap`. `CHECK=1` only shows what would be deployed. |
| `sudo make install-data SNAPSHOT=/tmp/x.sqlite.gz` | box | Installs an uploaded snapshot as the live database: verified first, refuses to replace live data without `FORCE=1`, keeps the old database, deletes the uploaded copy. |
| `make push-data SNAPSHOT=x.sqlite.gz VM=<instance> ZONE=<zone>` | your computer | Uploads a snapshot (and its manifest) with `gcloud`, then runs `install-data` on the VM. `FORCE=1` passes through. Needs `make` and `gcloud` on your machine; it uses only plain commands so it also works with Windows `make`. |

## First install
Put the repo on the box, then `cd` into it and run `sudo make bootstrap` from a terminal. Use `https://<domain>/healthz` to check TLS. Add `https://<domain>` as an authorized JavaScript origin on the Google OAuth client.

## Updating
On the box: `sudo make update`. Each run first copies the current database to `/var/backups/hearthkeeper/pre-deploy-<stamp>.sqlite.gz` (the last 14 are kept; rollback aids, not backups) because the app migrates its schema on start. To go back to an older version, check out the older commit and run `sudo make bootstrap`; a migrated schema is rolled back by restoring that copy by hand.

## Loading data
A snapshot is `<name>.sqlite.gz` plus `<name>.manifest.json`, kept side by side. `install-data` verifies it (checksums, row counts, SQLite integrity, money invariants, schema not newer than the code) and again after unpacking. The previous database goes to `/var/backups/hearthkeeper/pre-restore-<stamp>/`.
```
make push-data SNAPSHOT=hk-prod-20261005T230819Z.sqlite.gz VM=hearthekeeper ZONE=us-west1-b
```
Snapshots are made with `npm run hk -- snapshot --out <dir>` (check them with `npm run hk -- verify --file <x.sqlite.gz>`). Rebuilding one from the spreadsheets is `tools/xlsx_to_export.py` followed by the `init`, `migrate`, `seed-rules` and `profiles` commands in `docs/RUNBOOK.md`.

## Things to know
- **Ingest tokens live in the database.** Loading a database loads its tokens; read them with `node --import tsx src/seed/cli.ts tokens` in the checkout. Do not point IFTTT at the box before the data is installed.
- **The gap.** Anything between your spreadsheet export and the day the webhook starts is brought in with the bank CSV import.
- **Backups** are GCP disk snapshots (attach a daily schedule to the VM disk). There is no app-level backup job.
- **Privacy.** A snapshot holds your whole financial history plus ingest secrets and push keys. Delete local copies when done.
