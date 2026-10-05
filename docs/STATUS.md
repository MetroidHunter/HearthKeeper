# Build status against the v0.4 plan

Last verified: 241 unit/property/API tests (Vitest) plus the Web Test Runner browser suite (headless Chromium). CI runs both.

## Done
**Phase 0, foundations and migration**
- SQLite schema (7 migrations), integer-cent money (legacy fractions preserved exactly), Pacific/Eastern time handling, audit log, optimistic-lock versions.
- Balance engine with effective-dated budget versions, invariant checker.
- Legacy import from the real workbook. **Parity P1-P7 passes on your real sheet: 619 checks, 0 mismatches** (17,595 transactions, 103 categories). Needs `private/export/`; those tests skip themselves without it.
- Migration worksheet (resolve NEEDS CATEGORY leftovers with before/after balances) and merchant bootstrap.

**Phase 1, replace the Budget sheet**
- Categories, quick budget change, earnings scenarios, plans (diff, staleness guard, atomic go-live that now also drops later versions and skips retired categories, revert, RESTATE confirm).
- Rebalance/transfers, close checklist, period soft-lock with reopen.
- Budget page, pie, spend-by, Explore, analytics (monthly, trend, income vs spend, treemap, year pivot, budget vs actual).

**Phase 2, replace the transaction sheet**
- CSV import with mapping wizard, per-institution profiles, per-account de-dup, provisional-to-posted reconcile (exact before tolerance; superseding carries kind, pairing, notes), paired in-system transfers (transfer-like descriptor on both legs).
- Merchants, rules, backtest (seeded 236 rules checked against 16,675 historical rows), ranked suggestions, backlog mode with grouped bulk answers.
- Greenlight: nine message shapes plus declined/withdraw/request, per-profile policy, scored final-amount matching, expected-allowance fulfilment by nearest date.
- Notes matcher (global assignment, per-source windows, item splits with loose subset search).
- Chase alert parser (real format from `IFTTT_Code.gs`), including alerts that arrive after the CSV already posted the charge. Experimental Amazon/Venmo/PayPal receipt parsers are opt-in (`HK_EXPERIMENTAL_PARSERS=1`).

**Discovery track, ingest**: raw capture, HMAC/bearer auth, shapes page, idempotent replay. All 154 real IFTTT messages parse and replay.

**Phase 3**: Lit UI for every page above, PWA with service worker (versioned cache, no caching of auth/ingest, wiped on logout), web push (VAPID in settings, one-tap actions, retract on first answer, quiet hours, digest, lock-screen privacy), Google OIDC allowlist auth with a sign-in page (testable with an injected verifier), deploy files.

**Security review**: an independent pass found auth bypass via encoded paths, fingerprint ReDoS, SW caching of private data and others; all fixed with regression tests in `test/security.test.ts`.

## Not done, and why
| Item | Why |
|---|---|
| Real Google sign-in | Needs `HK_GOOGLE_CLIENT_ID` and `HK_ALLOWED_EMAILS` (your GCP side). |
| Real push to a device, real IFTTT webhook, DNS/TLS | Your side; nothing leaves the container. |
| Audit-log page, merchant-group UI, saved Explore searches | Backend exists; UI not built. |
| SimpleFIN, LLM fallback | Optional by design. |
| Wells Fargo notice parser | Needs real captured samples. |
| Regression test for "final amount on a user-split Greenlight reclass" | Fix is in (it flags instead of collapsing the split) but has no dedicated test yet. |

## Known judgement calls
See `docs/DECISIONS.md` (D36-D52). The legacy sheet's own quirks (retired-category month semantics, the `(blank)` group, sub-cent amounts) are replicated deliberately so parity holds.

## Your side
Domain/DNS, GCP VM, receiver Gmail + forwarding, Chase email alerts, IFTTT webhook applet, Apps Script install, OAuth client. Steps are in `docs/RUNBOOK.md`.
