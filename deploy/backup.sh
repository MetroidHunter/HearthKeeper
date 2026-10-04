#!/usr/bin/env bash
# Nightly SQLite backup to Cloud Storage (design §17.3). Cron: 15 3 * * * /opt/hearthkeeper/deploy/backup.sh
set -euo pipefail
source /etc/hearthkeeper.env
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)
sqlite3 "$HK_DATA_DIR/hearthkeeper.sqlite" ".backup '$TMP/hk-$STAMP.sqlite'"   # consistent online backup, safe in WAL mode
gzip "$TMP/hk-$STAMP.sqlite"
gsutil cp "$TMP/hk-$STAMP.sqlite.gz" "$HK_BACKUP_BUCKET/hk-$STAMP.sqlite.gz"
rm -rf "$TMP"
# keep the newest 30 (lifecycle rules on the bucket are the simpler alternative)
gsutil ls "$HK_BACKUP_BUCKET/" | sort | head -n -30 | xargs -r gsutil rm
