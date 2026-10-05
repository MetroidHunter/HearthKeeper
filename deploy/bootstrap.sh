#!/usr/bin/env bash
# HearthKeeper host bootstrap: idempotent, re-run it for every code update. Debian/Ubuntu, run as root on the VM.
#
#   sudo HK_DOMAIN=hearthkeeper.com \
#        HK_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
#        HK_ALLOWED_EMAILS=you@gmail.com,partner@gmail.com \
#        [HK_BACKUP_BUCKET=gs://bucket/hearthkeeper] [HK_INIT_USERS="Brys:you@gmail.com;Miracle:partner@gmail.com"] \
#        bash deploy/bootstrap.sh
#
# Settings are stored in /etc/hearthkeeper.env, so later runs need no variables. The session secret is generated once and kept.
# Code comes from the checkout this script lives in (deploy/push-code.sh copies it up), or HK_REPO_URL/HK_REF if you set them.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

APP=/opt/hearthkeeper
DATA=/var/lib/hearthkeeper
ENVF=/etc/hearthkeeper.env
BACKUPS=/var/backups/hearthkeeper
SRC_DIR=${HK_SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
log() { printf '\n==> %s\n' "$*"; }

# ---- settings ---------------------------------------------------------------------------------
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }          # previously stored values are the defaults
set_kv() { # set_kv KEY VALUE: replace-or-append in the env file without sed escaping traps
  local k=$1 v=$2; touch "$ENVF"; grep -v "^$k=" "$ENVF" > "$ENVF.tmp" || true; printf '%s=%s\n' "$k" "$v" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"
}
: "${HK_DOMAIN:?set HK_DOMAIN (e.g. hearthkeeper.com)}"
: "${HK_GOOGLE_CLIENT_ID:?set HK_GOOGLE_CLIENT_ID}"
: "${HK_ALLOWED_EMAILS:?set HK_ALLOWED_EMAILS (comma separated)}"
set_kv HK_DOMAIN "$HK_DOMAIN"
set_kv HK_AUTH google
set_kv HK_GOOGLE_CLIENT_ID "$HK_GOOGLE_CLIENT_ID"
set_kv HK_ALLOWED_EMAILS "$HK_ALLOWED_EMAILS"
set_kv HK_DATA_DIR "$DATA"
set_kv PORT 8080
[ -n "${HK_BACKUP_BUCKET:-}" ] && set_kv HK_BACKUP_BUCKET "$HK_BACKUP_BUCKET"
grep -q '^HK_SESSION_SECRET=' "$ENVF" || set_kv HK_SESSION_SECRET "$(openssl rand -hex 32)"
chmod 600 "$ENVF"

# ---- packages -----------------------------------------------------------------------------------
log "system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl sqlite3 rsync git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https >/dev/null
install -d -m 0755 /etc/apt/keyrings
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  log "node 22 (NodeSource apt repo)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  log "caddy (official apt repo)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

# an e2-micro has ~1 GB RAM: npm ci + vite build need swap
if ! swapon --show | grep -q .; then
  log "2 GB swapfile"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---- user, directories --------------------------------------------------------------------------
id hearthkeeper >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin hearthkeeper
install -d -o hearthkeeper -g hearthkeeper -m 0750 "$DATA"
install -d -m 0750 "$BACKUPS" "$APP"

# ---- code ----------------------------------------------------------------------------------------
log "code"
if [ -n "${HK_REPO_URL:-}" ]; then
  [ -d "$APP/.git" ] || git clone "$HK_REPO_URL" "$APP"
  git -C "$APP" fetch -q origin "${HK_REF:-main}" && git -C "$APP" checkout -q -B "${HK_REF:-main}" "origin/${HK_REF:-main}"
else
  [ -f "$SRC_DIR/package.json" ] || { echo "no package.json in $SRC_DIR (set HK_SRC_DIR or HK_REPO_URL)"; exit 1; }
  [ "$SRC_DIR" = "$APP" ] || rsync -a --delete --exclude node_modules --exclude data --exclude private --exclude dist --exclude .git "$SRC_DIR"/ "$APP"/
fi
cd "$APP"

# safety net before anything that may migrate the schema
if [ -f "$DATA/hearthkeeper.sqlite" ]; then
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  sqlite3 "$DATA/hearthkeeper.sqlite" ".backup '$BACKUPS/pre-deploy-$STAMP.sqlite'" && gzip -f "$BACKUPS/pre-deploy-$STAMP.sqlite"
  ls -1t "$BACKUPS"/pre-deploy-*.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
fi

log "npm ci + build (a few minutes on an e2-micro)"
npm ci --no-audit --no-fund --loglevel=error          # dev dependencies stay: the service runs TypeScript through tsx
npm run build --silent
chown -R root:root "$APP"; chmod -R go-w "$APP"

# ---- first-run data (only when no data was pushed and users were given) ---------------------------
if [ -n "${HK_INIT_USERS:-}" ] && [ ! -s "$DATA/hearthkeeper.sqlite" ]; then
  log "initialising an empty household (tokens saved to /root/hk-init-tokens.txt, mode 600)"
  ARGS=(); IFS=';' read -ra U <<< "$HK_INIT_USERS"; for u in "${U[@]}"; do ARGS+=(--user "$u"); done
  runuser -u hearthkeeper -- env HK_DATA_DIR="$DATA" node --import tsx src/seed/cli.ts init "${ARGS[@]}" > /root/hk-init-tokens.txt
  chmod 600 /root/hk-init-tokens.txt
fi

# ---- caddy, systemd -------------------------------------------------------------------------------
log "caddy + systemd"
sed "s/hearth\.example\.com/$HK_DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
install -m 0644 deploy/hearthkeeper.service /etc/systemd/system/hearthkeeper.service
install -m 0644 deploy/hearthkeeper-backup.service deploy/hearthkeeper-backup.timer /etc/systemd/system/
chmod +x deploy/*.sh
systemctl daemon-reload
systemctl enable --now hearthkeeper.service hearthkeeper-backup.timer >/dev/null
systemctl restart hearthkeeper.service
systemctl reload-or-restart caddy

# ---- checks ---------------------------------------------------------------------------------------
log "health"
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null || { journalctl -u hearthkeeper -n 40 --no-pager; echo "service did not become healthy"; exit 1; }
echo "service: healthy on 127.0.0.1:8080"
if curl -fsS -m 20 "https://$HK_DOMAIN/healthz" >/dev/null 2>&1; then echo "public:  https://$HK_DOMAIN/healthz OK (TLS certificate issued)"
else echo "public:  https://$HK_DOMAIN not reachable yet. Check DNS points here and GCP firewall allows tcp:80,443 (journalctl -u caddy)."; fi
if [ -n "${HK_BACKUP_BUCKET:-}" ]; then
  echo ok | gsutil -q cp - "$HK_BACKUP_BUCKET/.bootstrap-check" 2>/dev/null && gsutil -q rm "$HK_BACKUP_BUCKET/.bootstrap-check" \
    && echo "backup:  bucket writable" || echo "backup:  CANNOT write $HK_BACKUP_BUCKET (VM needs the devstorage.read_write scope; see deploy/gcp-setup.sh --fix-scopes). Local backups still run."
fi
[ -s "$DATA/hearthkeeper.sqlite" ] || echo "data:    empty database. Load yours with deploy/push-data.sh (see docs/DEPLOY.md)."
echo; echo "Done. Logs: journalctl -u hearthkeeper -f"
