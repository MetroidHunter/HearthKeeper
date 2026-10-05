#!/usr/bin/env bash
# Run ON THE BOX (as root) to deploy the latest code from GitHub. Same effect as push-code.sh, pulled instead of pushed.
#
#   sudo bash /opt/hearthkeeper/deploy/update.sh --setup     # once: creates a read-only deploy key, prints it for GitHub
#   sudo bash /opt/hearthkeeper/deploy/update.sh             # every update: fetch, build, restart, health check
#   sudo bash /opt/hearthkeeper/deploy/update.sh --check     # show what would be deployed, change nothing
#   sudo bash /opt/hearthkeeper/deploy/update.sh --ref <branch|tag|sha>   # deploy something other than main (also how you roll back)
# Needs the first install to have happened already (push-code.sh or bootstrap.sh), so that /etc/hearthkeeper.env exists.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
ENVF=/etc/hearthkeeper.env; SRC=/opt/hearthkeeper-src; KEY=/root/.ssh/hk_deploy
DEFAULT_URL=git@github.com:MetroidHunter/HearthKeeper.git
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
URL=${HK_GIT_URL:-$DEFAULT_URL}; REF=${HK_GIT_REF:-main}; MODE=deploy
while [ $# -gt 0 ]; do case $1 in
  --setup) MODE=setup;; --check) MODE=check;; --ref) REF=${2:?--ref needs a value}; shift;; *) echo "unknown option $1"; exit 1;; esac; shift; done
set_kv() { local k=$1 v=$2; grep -v "^$k=" "$ENVF" > "$ENVF.tmp" || true; printf '%s=%s\n' "$k" "$v" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"; }
[ -f "$ENVF" ] || { echo "$ENVF not found: run the first install (deploy/push-code.sh) before update.sh"; exit 1; }

if [ "$MODE" = setup ]; then
  install -d -m 700 /root/.ssh
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "hearthkeeper-deploy@$(hostname)" -f "$KEY"
  set_kv HK_GIT_URL "$URL"
  cat <<MSG
Add this as a READ-ONLY deploy key (GitHub: repo > Settings > Deploy keys > Add deploy key, leave "Allow write access" unchecked):

$(cat "$KEY.pub")

Then run:  sudo bash $0
MSG
  exit 0
fi

export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
case $URL in git@*|ssh://*) [ -f "$KEY" ] || { echo "no deploy key yet: run  sudo bash $0 --setup"; exit 1; };; esac   # https URLs (public repo, or token in the URL) need no key

if [ -d "$SRC/.git" ]; then git -C "$SRC" remote set-url origin "$URL"; else git clone -q "$URL" "$SRC"; fi
git -C "$SRC" fetch -q --tags origin
TARGET=$(git -C "$SRC" rev-parse --verify -q "origin/$REF^{commit}" || git -C "$SRC" rev-parse --verify -q "$REF^{commit}") || { echo "cannot resolve '$REF' (branch, tag or sha)"; exit 1; }
CURRENT=$(cat /opt/hearthkeeper/.deployed-commit 2>/dev/null || echo none)
echo "deployed: ${CURRENT:0:10}   target: ${TARGET:0:10} ($REF)"
if [ "$CURRENT" = "$TARGET" ] && [ "$MODE" != check ]; then echo "already up to date (re-running anyway: rebuild + restart)"; fi
if [ "$CURRENT" != none ] && git -C "$SRC" cat-file -e "$CURRENT^{commit}" 2>/dev/null; then git -C "$SRC" --no-pager log --oneline "$CURRENT..$TARGET" | head -20; fi
[ "$MODE" = check ] && exit 0

git -C "$SRC" checkout -q --detach "$TARGET"
HK_SRC_DIR=$SRC bash "$SRC/deploy/bootstrap.sh"
echo "$TARGET" > /opt/hearthkeeper/.deployed-commit
echo "Deployed ${TARGET:0:10}."
