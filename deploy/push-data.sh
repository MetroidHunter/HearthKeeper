#!/usr/bin/env bash
# Run on your computer. Uploads a snapshot to the VM and installs it (verified before and after the copy).
#   HK_VM=hearthkeeper HK_ZONE=us-west1-b bash deploy/push-data.sh private/snapshots/hk-xxx.sqlite.gz [--force]
# Make the snapshot with deploy/build-prod-db.sh (from your sheets) or `npm run hk -- snapshot --out private/snapshots`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
GZ=${1:?snapshot .sqlite.gz}; FORCE=${2:-}
MAN=${GZ%.sqlite.gz}.manifest.json
[ -f "$GZ" ] && [ -f "$MAN" ] || { echo "need $GZ and $MAN"; exit 1; }
echo "==> verifying locally"; npm run --silent hk -- verify --file "$GZ" --manifest "$MAN"
B=$(basename "$GZ"); MB=$(basename "$MAN")
if [ -n "${HK_HOST:-}" ]; then
  SSH=(ssh "$HK_HOST"); CP() { scp "$@" "$HK_HOST:/tmp/"; }
else
  : "${HK_VM:?set HK_VM or HK_HOST}"; Z=${HK_ZONE:+--zone $HK_ZONE}
  SSH=(gcloud compute ssh "$HK_VM" $Z --); CP() { gcloud compute scp $Z "$@" "$HK_VM:/tmp/"; }
fi
echo "==> uploading"; CP "$GZ" "$MAN"
echo "==> installing on the VM"
"${SSH[@]}" "sudo bash /opt/hearthkeeper/deploy/install-data.sh /tmp/$B $FORCE; rc=\$?; rm -f /tmp/$B /tmp/$MB; exit \$rc"
