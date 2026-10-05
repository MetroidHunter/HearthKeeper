#!/usr/bin/env bash
# Run ON THE BOX: git pull this checkout, then rebuild and restart via bootstrap.sh.
#   sudo bash deploy/update.sh            # pull, build, restart, health check
#   sudo bash deploy/update.sh --check    # fetch and list what would be deployed; change nothing
# git runs as the checkout's owner, so that user's existing credentials are used. To deploy another commit, check it out first.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -f /etc/hearthkeeper.env ] || { echo "/etc/hearthkeeper.env not found: run the first install (bootstrap.sh) before update.sh"; exit 1; }
OWNER=$(stat -c %U "$REPO")
G() { if [ "$OWNER" = root ]; then git -C "$REPO" "$@"; else runuser -u "$OWNER" -- git -C "$REPO" "$@"; fi; }

G fetch -q
if [ "${1:-}" = --check ]; then
  G --no-pager log --oneline HEAD..@{u} | sed 's/^/  incoming: /'
  [ -z "$(G rev-list HEAD..@{u})" ] && echo "up to date"
  exit 0
fi
[ -z "$(G status --porcelain --untracked-files=no)" ] || { echo "uncommitted changes in $REPO; commit or stash them first"; exit 1; }
BEFORE=$(G rev-parse --short HEAD)
G pull --ff-only
echo "$BEFORE -> $(G rev-parse --short HEAD)"
HK_SRC_DIR=$REPO bash "$REPO/deploy/bootstrap.sh"
