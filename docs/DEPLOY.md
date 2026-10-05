# Deploying HearthKeeper (and moving your data)

Everything here is a script in `deploy/`; nothing needs hand-typed commands on the VM. Scripts marked **laptop** run on your computer, **vm** on the server.

| Script | Where | What it does |
|---|---|---|
| `gcp-setup.sh` | laptop | Firewall (80/443) and static IP; prints the commands for a daily disk-snapshot schedule. *Untested against a real project.* |
| `push-code.sh` | laptop | Ships the current git commit to the VM as a tarball and runs `bootstrap.sh`. First install and every update. |
| `bootstrap.sh` | vm | Idempotent host setup: Node 22, Caddy (auto TLS), swap, service user, `npm ci` + build, systemd service, health checks. Remembers its settings in `/etc/hearthkeeper.env`. |
| `build-prod-db.sh` | laptop | Rebuilds the production database from your two spreadsheets, proves parity (exit 1 on mismatch), writes a verified snapshot. |
| `push-data.sh` / `install-data.sh` | laptop / vm | Uploads a snapshot and installs it: verified before and after copying, refuses to overwrite live data without `--force`, keeps the old database. |

## First deployment

1. **GCP** (optional): `HK_PROJECT=... HK_VM=... HK_ZONE=... bash deploy/gcp-setup.sh`
2. **Code and host:**
   ```
   HK_VM=<instance> HK_ZONE=<zone> \
   HK_DOMAIN=hearthkeeper.com \
   HK_GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com \
   HK_ALLOWED_EMAILS=you@gmail.com,partner@gmail.com \
   bash deploy/push-code.sh
   ```
   No gcloud? Use `HK_HOST=user@ip` and plain ssh. At the end the script reports service health, and whether the public HTTPS URL answers (TLS certificate issued).
3. **Data**: see below. Until you load data the app starts with an empty database.
4. Open `https://hearthkeeper.com`, sign in with an allowlisted Google account.

## Data migration

Two supported paths. Both end in the same place: a *snapshot* (`.sqlite.gz` + `.manifest.json`) that is verified, uploaded and installed.

**A. Rebuild from the spreadsheets (the cut-over path).** Export both workbooks as .xlsx with formulas calculated and put them in `private/`, then:
```
HK_USERS="Brys:you@gmail.com;Miracle:partner@gmail.com" bash deploy/build-prod-db.sh     # parity must say PASS
HK_VM=... HK_ZONE=... bash deploy/push-data.sh private/snapshots/hk-prod-<stamp>.sqlite.gz
```
`build-prod-db.sh` always starts from an empty directory, so it is repeatable: same sheets + same code = same database. The user list matters because it is stored in the database (used for notification routing); use real emails.

**B. Move an existing database** (for example after trying things out locally, or between VMs):
```
npm run hk -- snapshot --out private/snapshots          # run with HK_DATA_DIR pointing at the source data
bash deploy/push-data.sh private/snapshots/<name>.sqlite.gz
```
Backups are your GCP disk snapshots (no app-level backup job). SQLite in WAL mode survives a crash-consistent snapshot the same way it survives power loss. To restore, create a disk from a snapshot and attach it; there is no data script involved.

What the verifier proves (`npm run hk -- verify --file x.sqlite.gz`): gzip and SQLite checksums match the manifest, every table has the manifest's row count, SQLite `integrity_check` and `foreign_key_check` pass, money invariants hold (splits sum to amounts, transfer legs sum to zero), and the database does not come from newer code than the one deployed.

### Things to know before you cut over
- **Ingest tokens live in the database.** Shipping a database ships its tokens, so the IFTTT webhook URL and the Apps Script secret you configure must be the ones in the deployed database: `ssh` in and run `cd /opt/hearthkeeper && sudo node --import tsx src/seed/cli.ts tokens`, or read them from the output of `install-data.sh`. Do not point IFTTT at the VM before the data is installed, or its first captures land in the empty database and `--force` would discard them.
- **The gap.** The workbook is a point in time. Anything that happened between your export and the day the webhook starts reaching the VM arrives through the backlog CSV import (Imports page); the reconcile logic matches it against what is there.
- **Rollback.** `install-data.sh` keeps the previous database in `/var/backups/hearthkeeper/pre-restore-<stamp>/`, and `bootstrap.sh` keeps the last 14 local `pre-deploy-<stamp>.sqlite.gz` copies taken before each update (the app migrates the schema on start). These are rollback aids, not backups; they live on the same disk.
- **Privacy.** A snapshot contains your whole financial history plus ingest secrets and push keys. `private/` is gitignored; keep snapshots out of git and delete the uploaded copy from `/tmp` (the scripts do).
- **Not tested here:** `bootstrap.sh`, `gcp-setup.sh`, `push-*.sh` and `install-data.sh` need a real VM and gcloud, which this build environment does not have. The data path they wrap (`build-prod-db.sh`, `snapshot`, `verify`) was run end to end on your real sheets: parity PASS, 16,691 transactions, and the snapshot verified. Expect to fix a small thing or two on the first real run; the scripts stop on the first error and say where.

## Updating later
Commit, then `HK_VM=... HK_ZONE=... bash deploy/push-code.sh` (no other variables). It takes a pre-deploy rollback copy, rebuilds, restarts and health-checks.
