#!/bin/bash
# Runs as root from hearthkeeper-update.service. Consumes the request, runs `make update`, and logs between markers the app reads in Settings.
REPO=${1:?checkout directory}
LOG=/var/log/hearthkeeper-update.log
rm -f /var/lib/hearthkeeper/update.request       # consume first, so one request is one run even if this fails
exec > "$LOG" 2>&1                               # root-owned directory, so the app cannot redirect this with a symlink
chmod 0644 "$LOG"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "== update started $(ts)"
rc=0; trap 'if [ $rc -eq 0 ]; then echo "== update finished ok $(ts)"; else echo "== update finished failed (exit $rc) $(ts)"; fi' EXIT
cd "$REPO" || { rc=1; exit 1; }
make --no-print-directory update || rc=$?
exit $rc
