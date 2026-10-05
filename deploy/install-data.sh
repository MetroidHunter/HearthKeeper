#!/usr/bin/env bash
# Run on the VM as root (push-data.sh calls it). Installs a verified snapshot as the live database.
#   install-data.sh /tmp/hk-xxx.sqlite.gz [--force]
# Refuses to replace a database that already holds transactions unless --force; the old one is always kept under /var/backups/hearthkeeper.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
GZ=${1:?snapshot .sqlite.gz}; FORCE=${2:-}
MAN=${GZ%.sqlite.gz}.manifest.json
APP=/opt/hearthkeeper; source /etc/hearthkeeper.env
DB="$HK_DATA_DIR/hearthkeeper.sqlite"
cd "$APP"
HK() { node --import tsx src/seed/cli.ts "$@"; }

echo "==> verifying the uploaded snapshot (checksums, row counts, integrity, invariants)"
HK verify --file "$GZ" --manifest "$MAN"

if [ -s "$DB" ]; then
  N=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM transactions' 2>/dev/null || echo 0)
  if [ "${N:-0}" -gt 0 ] && [ "$FORCE" != --force ]; then echo "live database already has $N transactions; re-run with --force to replace it (the old one is kept)"; exit 2; fi
fi

echo "==> swapping the database in"
systemctl stop hearthkeeper
STAMP=$(date -u +%Y%m%dT%H%M%SZ); KEEP=/var/backups/hearthkeeper/pre-restore-$STAMP; mkdir -p "$KEEP"
for f in "$DB" "$DB-wal" "$DB-shm"; do [ -e "$f" ] && mv "$f" "$KEEP/"; done || true
gunzip -c "$GZ" > "$DB"
WANT=$(node -p "JSON.parse(require('fs').readFileSync('$MAN','utf8')).sqliteSha256")
GOT=$(sha256sum "$DB" | cut -d' ' -f1)
[ "$WANT" = "$GOT" ] || { echo "checksum mismatch after unpack; restoring the previous database"; rm -f "$DB"; for f in "$KEEP"/*; do mv "$f" "$HK_DATA_DIR/"; done; systemctl start hearthkeeper; exit 1; }
chown hearthkeeper:hearthkeeper "$DB"; chmod 600 "$DB"
systemctl start hearthkeeper
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null || { journalctl -u hearthkeeper -n 30 --no-pager; exit 1; }
echo "==> installed. Previous database kept in $KEEP"
echo "    ingest tokens now in effect:"; HK tokens | awk '{print "      "$1" ("$2")"}'
