# HearthKeeper

Self-hosted envelope budgeting with automatic ingestion and categorization. Replaces the `BudgetProgram` + `IFTTTTransactions` spreadsheets. Full design: [docs/DESIGN.md](docs/DESIGN.md). Build status, assumptions and your to-do list: [docs/STATUS.md](docs/STATUS.md).

```
npm install
npm test                       # unit + property + API + parity (vitest)
npm run test:e2e               # browser e2e: Web Test Runner + headless Chromium against the real API with demo data
npm run test:all
npm run build                  # web UI -> dist/web
npm run hk -- demo             # fictional data (HK_DATA_DIR=./data by default)
HK_AUTH=dev npm start          # http://127.0.0.1:8080  (HK_AUTH=dev skips sign-in; local use only)
npm run hk -- init --user "Brys:you@gmail.com"      # real first run: accounts, ingest tokens, core rules
npm run hk -- migrate --dir ./sheet-export --asof 2026-07-05   # import sheets + run P1-P7 parity
```

Real-data workflow: [docs/RUNBOOK.md](docs/RUNBOOK.md). Decisions made while building: [docs/DECISIONS.md](docs/DECISIONS.md).

Layout: `src/core` (money, time, balance engine, categories, rules, plans, transfers, close), `src/ingest` (raw events, auth, CSV, pairing, reconcile), `src/greenlight`, `src/notes` (Amazon/Venmo/PayPal matcher), `src/migration`, `src/seed`, `src/server` (Fastify API), `src/web` (Lit PWA), `deploy/` and `tools/` (Caddy, systemd, backup, receiver-mailbox Apps Script).
