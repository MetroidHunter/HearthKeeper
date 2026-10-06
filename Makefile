# HearthKeeper deploy tasks. `make help` lists them.
#
# On the box (needs root, so run with sudo; install make first with `sudo apt-get install -y make`):
#   sudo make bootstrap                        first install or re-run after code changes; asks for anything it does not know
#   sudo make update                           git pull this checkout, then bootstrap
#   sudo make update CHECK=1                   only show what would be deployed
#   sudo make install-data SNAPSHOT=/tmp/hk-xxx.sqlite.gz [FORCE=1]
# On your computer (gcloud logged in):
#   make push-data SNAPSHOT=path/to/hk-xxx.sqlite.gz VM=<instance> ZONE=<zone> [FORCE=1]

SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -euo pipefail -c
.SILENT:
.DEFAULT_GOAL := help

REMOTE_DIR ?= /opt/hearthkeeper
SNAPSHOT_MANIFEST = $(SNAPSHOT:.sqlite.gz=.manifest.json)
SNAPSHOT_FILE = $(notdir $(SNAPSHOT))
MANIFEST_FILE = $(notdir $(SNAPSHOT_MANIFEST))
ZONE_ARG = $(if $(ZONE),--zone $(ZONE),)

.PHONY: help bootstrap update install-data push-data tokens

help: ## list the targets
	@awk -F':.*## ' '/^[a-z-]+:.*## /{printf "  %-13s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# Idempotent host setup, and the update path: Node 22, Caddy (automatic TLS), swap, service user, build, systemd, health checks.
# Settings live in /etc/hearthkeeper.env, so later runs ask nothing. Source: this checkout (or HK_SRC_DIR / HK_REPO_URL).
bootstrap: ## [box, sudo] install or update everything
	[ "$$(id -u)" = 0 ] || { echo "run as root: sudo make bootstrap"; exit 1; }

	APP=/opt/hearthkeeper
	DATA=/var/lib/hearthkeeper
	ENVF=/etc/hearthkeeper.env
	BACKUPS=/var/backups/hearthkeeper
	SRC_DIR=$${HK_SRC_DIR:-$$PWD}
	log() { printf '\n==> %s\n' "$$*"; }

	# ---- settings ---------------------------------------------------------------------------------
	[ -f "$$ENVF" ] && { set -a; . "$$ENVF"; set +a; }          # previously stored values are the defaults
	set_kv() { # set_kv KEY VALUE: replace-or-append in the env file without sed escaping traps
	  local k=$$1 v=$$2; touch "$$ENVF"; grep -v "^$$k=" "$$ENVF" > "$$ENVF.tmp" || true; printf '%s=%s\n' "$$k" "$$v" >> "$$ENVF.tmp"; mv "$$ENVF.tmp" "$$ENVF"; chmod 600 "$$ENVF"
	}
	ask() { # ask VAR "question": keep the stored/exported value, else prompt when a terminal is attached, else fail with a clear message
	  local var=$$1 q=$$2 cur=$${!1:-}
	  if [ -z "$$cur" ]; then
	    [ -t 0 ] || { echo "$$var is not set and there is no terminal to ask on (export it, or run sudo make bootstrap from a terminal)"; exit 1; }
	    read -r -p "$$q: " cur; [ -n "$$cur" ] || { echo "$$var is required"; exit 1; }
	  fi
	  printf -v "$$var" '%s' "$$cur"
	}
	ask HK_DOMAIN "Domain (e.g. hearthkeeper.net)"
	ask HK_GOOGLE_CLIENT_ID "Google OAuth client ID (…apps.googleusercontent.com)"
	ask HK_ALLOWED_EMAILS "Allowed sign-in emails, comma separated"
	set_kv HK_DOMAIN "$$HK_DOMAIN"
	set_kv HK_AUTH google
	set_kv HK_GOOGLE_CLIENT_ID "$$HK_GOOGLE_CLIENT_ID"
	set_kv HK_ALLOWED_EMAILS "$$HK_ALLOWED_EMAILS"
	set_kv HK_DATA_DIR "$$DATA"
	set_kv PORT 8080
	grep -q '^HK_SESSION_SECRET=' "$$ENVF" || set_kv HK_SESSION_SECRET "$$(openssl rand -hex 32)"
	chmod 600 "$$ENVF"

	# ---- packages -----------------------------------------------------------------------------------
	log "system packages"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y -qq ca-certificates curl gnupg openssh-client openssl sqlite3 rsync git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https >/dev/null
	install -d -m 0755 /etc/apt/keyrings
	if ! command -v node >/dev/null || [ "$$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
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
	id hearthkeeper >/dev/null 2>&1 || useradd --system --home-dir "$$DATA" --shell /usr/sbin/nologin hearthkeeper
	install -d -o hearthkeeper -g hearthkeeper -m 0750 "$$DATA"
	install -d -m 0750 "$$BACKUPS" "$$APP"

	# ---- code ----------------------------------------------------------------------------------------
	log "code"
	if [ -n "$${HK_REPO_URL:-}" ]; then
	  [ -d "$$APP/.git" ] || git clone "$$HK_REPO_URL" "$$APP"
	  git -C "$$APP" fetch -q origin "$${HK_REF:-main}" && git -C "$$APP" checkout -q -B "$${HK_REF:-main}" "origin/$${HK_REF:-main}"
	else
	  [ -f "$$SRC_DIR/package.json" ] || { echo "no package.json in $$SRC_DIR (set HK_SRC_DIR or HK_REPO_URL)"; exit 1; }
	  [ "$$SRC_DIR" = "$$APP" ] || rsync -a --delete --exclude node_modules --exclude data --exclude private --exclude dist --exclude .git "$$SRC_DIR"/ "$$APP"/
	fi
	cd "$$APP"

	# rollback copy before anything that may migrate the schema (offsite backup is your GCP disk snapshots)
	if [ -f "$$DATA/hearthkeeper.sqlite" ]; then
	  STAMP=$$(date -u +%Y%m%dT%H%M%SZ)
	  sqlite3 "$$DATA/hearthkeeper.sqlite" ".backup '$$BACKUPS/pre-deploy-$$STAMP.sqlite'" && gzip -f "$$BACKUPS/pre-deploy-$$STAMP.sqlite"
	  ls -1t "$$BACKUPS"/pre-deploy-*.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
	fi

	log "npm ci + build (a few minutes on an e2-micro)"
	npm ci --no-audit --no-fund --loglevel=error          # dev dependencies stay: the service runs TypeScript through tsx
	npm run build --silent
	[ "$$SRC_DIR" = "$$APP" ] || chown -R root:root "$$APP"   # an in-place checkout keeps its owner so `git pull` keeps working
	chmod -R go-w "$$APP"

	# ---- first-run data (only when no data was pushed and users were given) ---------------------------
	if [ -n "$${HK_INIT_USERS:-}" ] && [ ! -s "$$DATA/hearthkeeper.sqlite" ]; then
	  log "initialising an empty household (tokens saved to /root/hk-init-tokens.txt, mode 600)"
	  ARGS=(); IFS=';' read -ra U <<< "$$HK_INIT_USERS"; for u in "$${U[@]}"; do ARGS+=(--user "$$u"); done
	  runuser -u hearthkeeper -- env HK_DATA_DIR="$$DATA" node --import tsx src/seed/cli.ts init "$${ARGS[@]}" > /root/hk-init-tokens.txt
	  chmod 600 /root/hk-init-tokens.txt
	fi

	# ---- caddy, systemd -------------------------------------------------------------------------------
	log "caddy + systemd"
	sed "s/hearth\.example\.com/$$HK_DOMAIN/g" deploy/Caddyfile > /etc/caddy/Caddyfile
	caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
	install -m 0644 deploy/hearthkeeper.service /etc/systemd/system/hearthkeeper.service
	systemctl daemon-reload
	systemctl enable --now hearthkeeper.service >/dev/null
	systemctl restart hearthkeeper.service
	systemctl reload-or-restart caddy

	# ---- checks ---------------------------------------------------------------------------------------
	log "health"
	for i in $$(seq 1 30); do curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null 2>&1 && break; sleep 1; done
	curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null || { journalctl -u hearthkeeper -n 40 --no-pager; echo "service did not become healthy"; exit 1; }
	echo "service: healthy on 127.0.0.1:8080"
	if curl -fsS -m 20 "https://$$HK_DOMAIN/healthz" >/dev/null 2>&1; then echo "public:  https://$$HK_DOMAIN/healthz OK (TLS certificate issued)"
	else echo "public:  https://$$HK_DOMAIN not reachable yet. Check DNS points here and GCP firewall allows tcp:80,443 (journalctl -u caddy)."; fi
	[ "$$(sqlite3 "$$DATA/hearthkeeper.sqlite" 'SELECT COUNT(*) FROM transactions' 2>/dev/null || echo 0)" -gt 0 ] || echo "data:    no transactions yet. Load your data with make push-data (see docs/DEPLOY.md)."
	echo; echo "Done. Logs: journalctl -u hearthkeeper -f"

# git pull as the checkout's owner (so their credentials are used), then bootstrap.
update: ## [box, sudo] git pull, rebuild, restart, health check (CHECK=1 to preview)
	[ "$$(id -u)" = 0 ] || { echo "run as root: sudo make update"; exit 1; }
	REPO=$$PWD
	[ -f /etc/hearthkeeper.env ] || { echo "/etc/hearthkeeper.env not found: run sudo make bootstrap first"; exit 1; }
	OWNER=$$(stat -c %U "$$REPO")
	G() { if [ "$$OWNER" = root ]; then git -C "$$REPO" "$$@"; else runuser -u "$$OWNER" -- git -C "$$REPO" "$$@"; fi; }

	G fetch -q
	if [ -n "$${CHECK:-}" ]; then
	  G --no-pager log --oneline HEAD..@{u} | sed 's/^/  incoming: /'
	  [ -z "$$(G rev-list HEAD..@{u})" ] && echo "up to date"
	  exit 0
	fi
	[ -z "$$(G status --porcelain --untracked-files=no)" ] || { echo "uncommitted changes in $$REPO; commit or stash them first"; exit 1; }
	BEFORE=$$(G rev-parse --short HEAD)
	G pull --ff-only
	echo "$$BEFORE -> $$(G rev-parse --short HEAD)"
	$(MAKE) --no-print-directory bootstrap

# Installs a snapshot as the live database: verified first, refuses to replace live data without FORCE=1, keeps the old one.
install-data: ## [box, sudo] install an uploaded snapshot (SNAPSHOT=..., FORCE=1)
	[ "$$(id -u)" = 0 ] || { echo "run as root: sudo make install-data SNAPSHOT=..."; exit 1; }
	GZ=$$(readlink -f "$${SNAPSHOT:?pass SNAPSHOT=/path/to/hk-xxx.sqlite.gz}"); FORCE=$${FORCE:+--force}
	MAN=$${GZ%.sqlite.gz}.manifest.json
	set -a; source /etc/hearthkeeper.env; set +a   # exported, so the CLI below finds the real data directory
	DB="$$HK_DATA_DIR/hearthkeeper.sqlite"
	# run the CLI from the deployed app (its node_modules live in /opt/hearthkeeper), whichever checkout make was started from
	APP=/opt/hearthkeeper; [ -d "$$APP/node_modules" ] || APP=$$PWD
	HK() { (cd "$$APP" && node --import tsx src/seed/cli.ts "$$@"); }

	echo "==> verifying the uploaded snapshot (checksums, row counts, integrity, invariants)"
	HK verify --file "$$GZ" --manifest "$$MAN"

	if [ -s "$$DB" ]; then
	  N=$$(sqlite3 "$$DB" 'SELECT COUNT(*) FROM transactions' 2>/dev/null || echo 0)
	  if [ "$${N:-0}" -gt 0 ] && [ "$$FORCE" != --force ]; then echo "live database already has $$N transactions; re-run with --force to replace it (the old one is kept)"; exit 2; fi
	fi

	echo "==> swapping the database in"
	systemctl stop hearthkeeper
	STAMP=$$(date -u +%Y%m%dT%H%M%SZ); KEEP=/var/backups/hearthkeeper/pre-restore-$$STAMP; mkdir -p "$$KEEP"
	for f in "$$DB" "$$DB-wal" "$$DB-shm"; do [ -e "$$f" ] && mv "$$f" "$$KEEP/"; done || true
	gunzip -c "$$GZ" > "$$DB"
	WANT=$$(node -p "JSON.parse(require('fs').readFileSync('$$MAN','utf8')).sqliteSha256")
	GOT=$$(sha256sum "$$DB" | cut -d' ' -f1)
	[ "$$WANT" = "$$GOT" ] || { echo "checksum mismatch after unpack; restoring the previous database"; rm -f "$$DB"; for f in "$$KEEP"/*; do mv "$$f" "$$HK_DATA_DIR/"; done; systemctl start hearthkeeper; exit 1; }
	chown hearthkeeper:hearthkeeper "$$DB"; chmod 600 "$$DB"
	systemctl start hearthkeeper
	for i in $$(seq 1 30); do curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 1; done
	curl -fsS http://127.0.0.1:8080/healthz >/dev/null || { journalctl -u hearthkeeper -n 30 --no-pager; exit 1; }
	echo "==> installed. Previous database kept in $$KEEP"
	echo "    ingest tokens now in effect:"; HK tokens | awk '{print "      "$$1" ("$$2")"}'
	rm -f "$$GZ" "$${GZ%.sqlite.gz}.manifest.json"

# Prints the ingest token secrets (for the IFTTT URL and the receiver script). Runs from the deployed app, whichever checkout you are in.
tokens: ## [box, sudo] print the ingest token secrets
	[ "$$(id -u)" = 0 ] || { echo "run as root: sudo make tokens"; exit 1; }
	set -a; source /etc/hearthkeeper.env; set +a
	APP=/opt/hearthkeeper; [ -d "$$APP/node_modules" ] || APP=$$PWD
	echo "label	channel	secret"
	cd "$$APP" && node --import tsx src/seed/cli.ts tokens

# Uploads a snapshot to the VM and installs it there. Written with plain commands (no shell syntax) so it also runs under Windows make.
push-data: ## [laptop] upload a snapshot and install it on the VM (SNAPSHOT=, VM=, ZONE=, FORCE=1)
	$(if $(SNAPSHOT),,$(error pass SNAPSHOT=path/to/hk-xxx.sqlite.gz))
	$(if $(VM),,$(error pass VM=<instance name>))
	gcloud compute scp $(ZONE_ARG) "$(SNAPSHOT)" "$(SNAPSHOT_MANIFEST)" $(VM):/tmp/
	gcloud compute ssh $(VM) $(ZONE_ARG) --command "sudo make -C $(REMOTE_DIR) install-data SNAPSHOT=/tmp/$(SNAPSHOT_FILE) $(if $(FORCE),FORCE=1,)"
