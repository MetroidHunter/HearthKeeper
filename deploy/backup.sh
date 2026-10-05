#!/usr/bin/env bash
# Nightly SQLite backup (design §17.3). Always keeps 14 local copies; also uploads to $HK_BACKUP_BUCKET when set. Run by hearthkeeper-backup.timer.
set -euo pipefail
source /etc/hearthkeeper.env
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOCAL=/var/backups/hearthkeeper
mkdir -p "$LOCAL"
OUT="$LOCAL/hk-$STAMP.sqlite"
sqlite3 "$HK_DATA_DIR/hearthkeeper.sqlite" ".backup '$OUT'"   # consistent online backup, safe in WAL mode
[ "$(sqlite3 "$OUT" 'PRAGMA integrity_check')" = ok ] || { echo "backup failed integrity_check"; rm -f "$OUT"; exit 1; }
gzip -f "$OUT"
ls -1t "$LOCAL"/hk-*.sqlite.gz | tail -n +15 | xargs -r rm -f
if [ -n "${HK_BACKUP_BUCKET:-}" ]; then
  gsutil -q cp "$OUT.gz" "$HK_BACKUP_BUCKET/hk-$STAMP.sqlite.gz"
  gsutil ls "$HK_BACKUP_BUCKET/" | grep '/hk-' | sort | head -n -30 | xargs -r gsutil -q rm   # newest 30 remote (a bucket lifecycle rule also works)
fi
echo "backup $STAMP done"
