# Build status against the v0.4 plan

## Done (all covered by tests unless noted)
**Phase 0, foundations and migration**
- SQLite schema (§7), integer-cent money, Pacific/Eastern time handling, audit log, optimistic-lock versions.
- Balance engine (§6.1): effective-dated budget versions, accrual, transfers, Spent/Gained (net, plus sheet-compatible mode with the Zero Out leak), invariant checker (§7.8).
- Legacy import (§18.2) from CSV exports of `List`, `History`, `Budget`, `Transactions`: replicates the sheet's silent History drop (and reports it), reallocation detection (reingest / reignest / zero out / ingest), split-group linking without merging, NEEDS CATEGORY and blank rows as `needs_category`, categories missing from List, duplicate/stray Budget rows, likely-retired categories.
- Parity harness P1-P7 with an explanations mechanism. Tested against an independently written reference of the sheet's `historicalBudget` semantics.

**Phase 1, replace Phase 2**
- Categories CRUD/retire, quick budget change with history timeline, earnings scenarios (matches the $220k @ 32% = $12,466.67 example), plans with diff, staleness guard, atomic go-live, revert, retroactive "RESTATE" confirm with per-category balance impact.
- Transfers: rebalance (Gig Income pool first, priority order, discretionary then cushion-gated donors), hand placement, manual transfer, zero-out adjustment. Close checklist (§13.4) and optional period lock record.
- Reports: Budget page for any two periods, budget pie (allocated/spent, group drill-down), spend-by (category/merchant/merchant group/month/account), Explore.

**Phase 2, replace Phase 1**
- CSV import: column-mapping wizard backend, saved profiles keyed by layout, multiset de-dup, backlog counts, coverage/stale, provisional-to-posted reconcile, paired in-system transfers (descriptor evidence required; savings transfer stays real; refund not mistaken for a transfer).
- Merchants/aliases/groups, descriptor cleaning, rules engine (cents comparison, word match, priority + specificity, conflicts, backtest), learned rules with clean-confirmation tracking and promote-to-auto offer, ranked suggestions (§9.5).
- Greenlight: parsers for the nine observed shapes, per-profile policy engine (allowance charges; funding is an internal transfer; Miracle reclass sums to zero and re-derives on final amount; Marion ignored; requests never charge; expected-allowance forecast; wallet balance; attribution check).
- Notes matcher: source/owner-aware, global (Hungarian) assignment, margin-based ambiguity as a state, per-source windows, vague-note detection, phantom points rows dropped, item splits with tax/shipping allocation and multi-shipment subset search.
- Guesser converter (`IFTTT_guess.gs` to rules; see assumption 3).

**Discovery track (D0)** — `/ingest/device` and `/ingest/email` capture every payload raw (HMAC with replay protection, or bearer token for IFTTT), parse nothing unknown, Shapes page clusters by template, replay is idempotent, silence alerts, heartbeat.

**Phase 3, partial**: web UI (Home/Needs-you, Budget, Transactions with splits editor, Plans, Earnings, Transfers, Close, Imports, Rules & merchants, Greenlight, Explore, Dashboard, Categories, Ingest health), installable PWA with service worker (offline read-only, queued answers, push handler with one-tap action buttons). Google OIDC allowlist auth, CSRF header, deploy files (Caddy, systemd, nightly backup, restore drill), receiver-mailbox Apps Script.

## Not done, and why
| Item | Why deferred |
|---|---|
| Chase alert, Amazon/Venmo/PayPal receipt, Wells Fargo notice parsers | Need real captured samples (the plan's discovery track). Capture is live; write parsers after a month of data, then `replay`. |
| Web push *sending* (VAPID, notification policy, daily digest) | Needs your VAPID keys and a real device to verify; the client side (subscribe handler, action buttons) exists. Hook point: `startScheduler(onAlert)`. |
| Google sign-in button / client id | Needs your Google OAuth client. Server side verifies ID tokens; UI has no sign-in page yet (dev mode only works out of the box). |
| SimpleFIN, LLM fallback (Phase 4/5 options) | Optional by design. |
| Full chart catalog | Pie, bars and explore exist; heatmap/treemap/step charts are Phase 4. |
| Real migration run and parity | Needs your sheet exports (see below). |

## Assumptions to verify
1. **Sheet export layout.** I did not have `BudgetProgram_structure_reference.md` or the scripts, so exports are matched by header names (aliases in `src/migration/sheet.ts`): List(Name, Parent, Start Date, Deprecated), History(Category, Amount, Month Stopped Using), Budget(Name, Budget), Transactions(Date, Name, Category, Amount, Notes, Split Total). Oracle files: `oracle_internal_AB.csv`, `oracle_internal_HJ.csv`, `oracle_budget_current.csv`, `oracle_periods.csv`, `oracle_allocated.txt`, `oracle_txn_count.txt`, `oracle_txn_total.txt`. Tell me if headers differ.
2. A List category with no Budget row and no History is imported with a 0 target; whether the sheet's `Internal!H:J` accrues for it is unknown (parity will show).
3. The guesser converter expects `case toCheck.includes("x") [|| &&] price == '-150': return "Cat";` per the design's description; unreadable cases are reported, never dropped. Not yet run against the real file.
4. IFTTT timestamp format is assumed `on October 3, 2026 at 09:15PM` (or `M/d/yyyy`); otherwise arrival time is used. First real webhook will confirm.
5. Account scoping: the legacy import books everything to one non-in-system `Legacy` account.
6. I used `better-sqlite3` directly rather than Kysely (a thin typed layer can be added; schema is plain SQL).

## Your side of D0 (about an hour)
Buy domain/DNS, GCP e2-micro in us-west1, receiver Gmail + Gmail forwarding filters, Chase email alerts to the receiver, second IFTTT applet with a webhook action to `https://<host>/ingest/device?token=<secret>` (token printed once by `npm run hk -- init`), install `tools/receiver-apps-script.gs` in the receiver account. Then export the sheets and run `migrate`.
