#!/usr/bin/env bash
# Run on your computer. Ships the current git commit to the VM and runs bootstrap.sh there (first install and every update).
# No git credentials are needed on the VM: the tree travels as a tarball over ssh.
#
#   HK_VM=hearthkeeper HK_ZONE=us-west1-b \
#   HK_DOMAIN=hearthkeeper.com HK_GOOGLE_CLIENT_ID=... HK_ALLOWED_EMAILS=a@x.com,b@x.com bash deploy/push-code.sh
# Without gcloud, use plain ssh instead:  HK_HOST=you@1.2.3.4 ...
# The bootstrap variables are only needed the first time; the VM remembers them in /etc/hearthkeeper.env.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git diff --quiet HEAD -- || echo "warning: uncommitted changes are NOT deployed (only HEAD is)"
REMOTE_ENV=""
for v in HK_DOMAIN HK_GOOGLE_CLIENT_ID HK_ALLOWED_EMAILS HK_INIT_USERS; do [ -n "${!v:-}" ] && REMOTE_ENV+=" $v=$(printf '%q' "${!v}")"; done
if [ -n "${HK_HOST:-}" ]; then SSH=(ssh "$HK_HOST"); else : "${HK_VM:?set HK_VM (instance name) or HK_HOST}"; SSH=(gcloud compute ssh "$HK_VM" ${HK_ZONE:+--zone "$HK_ZONE"} --); fi
git archive --format=tar HEAD | "${SSH[@]}" 'rm -rf /tmp/hk-src && mkdir -p /tmp/hk-src && tar -x -C /tmp/hk-src'
"${SSH[@]}" "sudo env$REMOTE_ENV HK_SRC_DIR=/tmp/hk-src bash /tmp/hk-src/deploy/bootstrap.sh && rm -rf /tmp/hk-src"
