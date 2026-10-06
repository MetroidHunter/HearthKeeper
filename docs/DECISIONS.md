# Decisions made while building (not in the design doc)

Each entry: what, why, and how to undo it. Newest last. The design doc (`DESIGN.md`) stays as written; where reality disagreed, this file records the deviation.

## D36. Amounts are numbers of cents and may be fractional (legacy fidelity)
**What.** `*_cents` columns hold cents as JS numbers. Anything that comes from a bank, an alert, a CSV or the UI is a whole number of cents; the legacy import preserves the sheet's amounts exactly, so a few values are fractional cents.
**Why.** The real `Transactions` sheet has 3,000+ rows with half-cent or finer amounts (`-13.765`, up to 6 decimals from `SplitCost`), and budget targets like `=400/12` and History values like `16.66666667`. Rounding each to whole cents would drift lifetime balances by dollars (hundreds of half-cent rows in one category). The design's "integer cents" goal was written without seeing this data.
**Consequences.** Parity compares within half a cent (`TOLERANCE_CENTS` in `src/migration/parity.ts`), because the sheet itself adds a float transaction sum to an accrual rounded by `toFixed(2)`. Negative zero is avoided (`0 - x`). The UI formats to cents. New data stays integer, so drift can only come from the legacy rows.
**Undo.** Round legacy amounts on import (one line in `src/migration/sheet.ts`) and accept the drift.

## D37. Real parity result
`npm run hk -- migrate` on the real BudgetProgram export: 619 checks, 0 mismatches (P1 months and totals, P2 lifetime transaction sums, P3 `Current`, P4 spent/gained for the last two months with data, P5 count and total, P6 allocated). Notes on how the oracle is read:
- The sheet counts **months only up to a retired category's last stop month** (exclusive); live categories count through the current month inclusive. Parity encodes exactly that.
- Blank-category rows are their own group in `Internal!A:B` (`(blank)`), separate from `NEEDS CATEGORY`.
- The cached "this/last month" blocks were empty (no transactions since July 2026), so P4 uses an independent re-implementation of the sheet's QUERY for the last two months that have data (`tools/xlsx_to_export.py`).
- `Internal` formulas in the xlsx show `Transactions!C2:D1501` but the live sheet uses open-ended ranges (`temp` tab); the cached values match the open-ended version (checked against the sum of all 17,595 rows).

## D38. Greenlight: shapes the design did not list
Seen in the real corpus (154 messages): `X withdrew $N from|at VENDOR`, three declined variants (spend control, insufficient funds on card, exceeded PIN attempts, bare "was declined"), `X entered an incorrect PIN` (noise), plus a request shape from `IFTTT_Code.gs` (`X requests $N to ...`). All parse; every captured message parses to a known shape.
**Withdraw policy.** Default `ask`: an ignored transaction is created and **flagged** so it appears in the inbox. `ignore` drops it; `debit_category` books an extra allowance debit. Under option A the allowance already charged the profile, so a withdrawal never re-charges on its own.
**Requests.** A request message creates a *pending* request and notifies; it never posts a charge (§11.5). The approval message is still unseen (D23).

## D39. Chase alert shape comes from the old script
`Prime Visa: You made a $X transaction with VENDOR on <date> at <time> ET.` The parser searches for the sentence (so an email body wrapping it works), parses Eastern wall-clock time with a real tz database **at the alert's own date**, and stores `occurred_on` as the Pacific date. Creates a *provisional* transaction; the CSV row later supersedes it (tolerance matching for tips).

## D40. Suggestion ranking has a fallback
`suggestionsFor` ranks: the suggesting rule, the merchant's past categories, similar descriptors, then your most-used expense categories (last ~120 days). Without the last step a brand-new merchant produced a prompt with no one-tap answers.

## D41. Merchant bootstrap never sets default categories
History books restaurants to personal buckets (`Brys Spending`, `Miracle Spending`, `Miracle Cash Overflow`), so a majority-category default would suggest those for every DoorDash order. The backtest of your real `IFTTT_Guess.gs` rules against all history confirms it: the largest "disagreements" are person buckets, not rule errors. Merchants are created `unreviewed`; you decide defaults on the review page.

## D42. Backtests are read-only
`suggestCategory(..., { readOnly, rules, aliases })` does not create merchants or bump rule hit counts, and caches rules (35 s -> 2.8 s over 16,675 rows).

## D43. Indexes
`transaction_splits(transaction_id)` was missing; the close checklist took 5.5 s on the real data. Added with four other indexes; a perf guard test (`test/perf.test.ts`, 20k rows) fails if it regresses.

## D44. Experimental receipt parsers are opt-in
(Superseded by D66: the parsers are now real and on by default.) `HK_EXPERIMENTAL_PARSERS=1` registered Amazon/Venmo/PayPal email parsers written from the *common* shapes (no real samples yet). They are strict-or-unrecognized, only write `external_notes`, and are off by default so a wrong guess can never create data. Replace the regexes with real fixtures after the discovery month.

## D45. Test strategy
Vitest stays (unit, property/fuzz, API via `fastify.inject`, parity). Browser e2e is **Web Test Runner + headless Chromium** (`npm run test:e2e`): it boots the real Fastify API with the demo database and drives the real Lit UI. CI (`.github/workflows/ci.yml`) runs typecheck, unit, build and e2e. Tests that need your private export skip themselves when it is absent; their setup lives in `beforeAll` because a skipped `describe` body still runs.

## D46. The e2e suite found real UI bugs
Split editor lost edits on re-render; buttons stayed disabled after typing because forms mutated nested objects (Lit does not re-render). Fixed; the tests that found them stay.

## D47. Sign-in is testable without a Google client ID
`/auth/me` reports mode and user; `registerAuth` takes a `verifyIdToken` function (default: Google's tokeninfo endpoint). Tests inject a fake verifier. Real sign-in only needs `HK_GOOGLE_CLIENT_ID` and `HK_ALLOWED_EMAILS`.

## D48. Notifications
Real-time pushes only for the fast lane (Chase alerts, Greenlight); CSV-derived items wait for the morning digest. Unknown purchaser -> both phones; the first answer sends a `close` push to the other. Replay of stored events is silenced. Push transport is pluggable (`memoryTransport` in tests; nothing leaves the process). VAPID keys are generated once into `settings`.

## D49. Auth is enforced by matched route, not raw URL
A request to `/%61pi/...` bypassed a prefix check on the raw URL. Protection now keys off `req.routeOptions.url`, so whatever Fastify routes to `/api/*` is protected. Logout requires the CSRF header.

## D50. Review fixes to money paths
- Go-live deletes later budget versions of the changed categories (audited) so an old future version cannot silently override the plan; plan items for non-active categories are ignored.
- Sub-cent legacy drift (< 0.5 cent) is not an overage or a nonzero pool; rebalance donor capacity is floored to whole cents.
- Retire uses the real month end (the 28th dropped 29-31 spend).
- Pairing needs transfer-like descriptors on both legs; the notes matcher treats `needs_note` rows as terminal; notes CSV dedupe is multiset-based.
- Greenlight final-amount: containment beats a shared token, closest amount then date wins, a token-only match is refused when ambiguous; a user-split reclass is flagged, never collapsed. Unrecognized/noise outcomes are not recorded as processed so replay can reprocess them after a parser fix.
- Item splits with unknown order total: subset search tolerates up to ~15% tax/shipping (5% under, for promos).

## D51. Reconcile semantics
Provisional rows match posted rows exact-first, then by unique tolerance; stale provisionals still match; superseding carries kind, pairing, owner, note state and repoints matched notes; de-dup is scoped to the account; import profile signatures are institution-prefixed.

## D52. Late Chase alerts
An alert whose charge already posted via CSV (same account, amount, date within 2 days, shared descriptor token) attaches to the posted row (`late_alert`) instead of creating a duplicate provisional.

## D53. Deployment is scripts, not instructions
`make bootstrap` is idempotent and is also the update path (deploy tasks live in the top-level Makefile; only `Caddyfile`, the systemd unit and the env example remain in `deploy/`); it keeps its settings in `/etc/hearthkeeper.env`. Code reaches the VM as a `git archive` tarball over ssh, so the VM needs no git credentials. Data moves as a verified snapshot (`hk snapshot` / `hk verify`: checksums, row counts, SQLite integrity, money invariants, schema-version check) rather than by re-running the migration on the server, so the server never needs the spreadsheets. Rebuilding from the sheets stays a laptop-side, repeatable script (`build-prod-db.sh`).

## D54. No app-level backups
Backups are GCP disk snapshots (daily schedule, `gcp-setup.sh` prints the commands). The nightly job, bucket and its permissions were removed. Only the on-disk rollback copies taken before an update or a data install remain.

## D55. "Needs category" is an envelope you can see
Uncategorized transactions were already outside every envelope (they sit in the `needs_category` state), which made the sheet's NEEDS CATEGORY category look like it had zeroed out: its legacy rows net to $0.20 because reingest credits offset them. Rather than force a number, the Budget page, Home and Dashboard now show a "Needs category" total (sum of every transaction still waiting for a category, with count). Categorizing a transaction moves its amount out of it and into the chosen category, and the confirm dialog shows that category's balance before and after. The starting figure is whatever is uncategorized after the bank backlog is imported. Parity is untouched (display only).

## D56. Information architecture and UI rules
Top level: Home, Budget, Backlog, Transactions. Data: Categories, Transfers, Plans, Earnings, Imports, Close. Discover: Dashboard, Analytics, Explore. Settings: Preferences, Greenlight, Rules & merchants, Ingest health, Migration. Every page opens with an explanation block; table headers carry hover help; spacing comes from one token scale (`--gap`, `--page-x`) so every page shares margins. Lists are rows or cards, never chips. Every category dropdown is the type-to-search `hk-category-select`. Dialogs are native modal `<dialog>`s so they always sit above the page. Theme (match device / light / dark) is a per-device setting in Preferences.

## D57. Every Home/Backlog item says why it is there, and counts are true counts
The inbox returns real totals (not the 200-row list limit) and a plain-language reason per item (no rule matches, left in NEEDS CATEGORY, your "???" note, waiting on a note, pending too long). Home's headline is the true number of distinct items; the Backlog groups uncategorized items by merchant, so its list is shorter than the count by design, and both pages say so. Greenlight reclasses are shown and booked at their real spend, not their zero total.

## D58. Everything from the spreadsheet import is valid as it stands
Nothing that predates the seed is asked for a category or a note. `grandfatherSeed` (run after parity in `hk migrate`, by `hk grandfather`, and at every server start; idempotent and instant once done) moves the imported rows that had no category to a reserved category, "Predates Oct 2026 Seed" (`categories.system = 1`, kind `income_reference`, retired). It cannot be picked, used in a rule, unretired or shown on the Categories page, but the name appears on the transactions that carry it. Imported Amazon/Venmo/PayPal rows with no note get the note "Predates Oct 2026 Seed". Every imported row is marked (`note_source = 'seed'`) so the note matcher never flags it later. New transactions after the seed still need categories and notes. Bare "???" follow-up flags from the sheet are cleared with the same note (the one flag with a real remark, "FLAG: needs follow-up ...", stays). Only rows written by the initial sheet import are touched (their splits carry origin `legacy`, which nothing else writes); bank CSV imports and live capture are never affected.

## D59. Pop-ups
Dialogs that ask for a decision (confirm, categorize, retire, add) ignore outside clicks; Esc still cancels. Informational dialogs and the transaction detail close on an outside click. The category list renders inside the dialog it opens from, because only top-layer content can sit above a modal. Hover hints are click-through, so they vanish when the pointer leaves the item. Opening one nav menu closes the others.

## D60. Answering a Greenlight spend re-attributes it
A Greenlight spend has a zero total (the allowance already charged the child's category). One-tap answers from Home, Backlog or the API used to replace its two offsetting splits with a single $0 split, so nothing moved. `answerCategory` now writes the offsetting pair (chosen category -spend, the child's category +spend). Failed saves on Home/Backlog show a dialog with the server's message; the category picker no longer lets the inner input's native `change` event escape as a malformed one.

## D61. One card per transaction, one way out per open reason
A transaction can wait on several things at once (a category, a note, a flag, a pending charge that never posted). Home and Backlog now show it once, list every open reason, and give each its own action: category options, note (pick a matching note, type one, or "no note needed"), "Mark as reviewed", "Hide it: it never posted". Categorizing one reason leaves the card in place showing "✓ Category: X" and what is still open; saves are confirmed with a toast. Before this, an uncategorized Amazon/Venmo/PayPal payment looked unchanged after you categorized it, because it was still waiting on its note.

## D62. Checklist cards
Home and Backlog cards show Category and Note (and Flag / Never-posted when they apply) as a checklist: a large "?" for what is missing or unknown, a check when settled, and a dash for a note that is not needed. The best category guess is one button ("Use Groceries"); other suggestions and the full search are collapsed; the account, the bank's full line, nearby transactions and "Not a budget item" sit behind Details. A note can be added or edited from any card. The Transactions list shows notes in place of the account (the account is in the row's detail).

## D63. Home order
Needs attention first (collapsible, open by default, the choice remembered per device), Favorites second, Recent third; searching and Add transaction come last. No intro text on Home. On phones, favorites are 2-column tiles of three short lines (name, balance, spent of target) with the pace bar as a strip along the tile's bottom edge, and the star (pinning) moves to the Budget page, taking each tile from ~87px to ~72px tall.

## D64. Needs attention starts collapsed; one phone automation can feed Chase too
The Home "Needs attention" section is collapsed on a fresh device (the count stays visible in its heading) and remembers how you leave it. On the device channel a Chase card alert sent without an explicit `source` is recognised by its wording and stored as `chase_alert`, so a single IFTTT automation can forward both Greenlight and Chase notifications. Setup steps are in `docs/CAPTURE.md`.

## D65. Notification devices: one switch per device, no master checkbox
Settings lists the signed-in person's devices (browser and OS from the user-agent, "This device" badge, added and last-delivered dates) with Remove, and the main button reflects this browser: "Turn on notifications on this device" when it is not subscribed, "Turn off notifications on this device" when it is. The old "Send push notifications to me" checkbox is gone from the UI because it duplicated what removing devices does and nobody could tell the two apart; the stored preference remains, and if an old setting left it off a banner offers to turn it back on. The unsubscribe endpoint now only removes the caller's own subscriptions. `sudo make tokens` prints the ingest token secrets from the deployed app.

## D66. Receipt and Wells Fargo parsers are real and on by default
Parsers for Amazon "Ordered N items", Venmo paid/received, PayPal receipt and merchant payment, and the Wells Fargo "account update" alert were rewritten against real emails (sanitized fixtures in `test/fixtures/receipts`). The forwarder's HTML part is rendered to lines by the server (`src/receipts/text.ts`) because Venmo's plain part is empty and its amounts are split across elements. Still strict-or-unrecognized; receipts only create notes; `HK_DISABLE_RECEIPT_PARSERS=1` is the off switch. A Wells Fargo alert creates a provisional transaction on the account with the matching `accounts.last4` (editable in Settings; no match is an error that replays once set), skips lines already present, and is superseded by the bank CSV like a Chase alert, so CSV uploads that overlap emailed transactions are safe. Amazon's email names no products, only categories per order, so notes are category-level. Unverified: Wells Fargo deposit lines and multi-line alerts (assumed to share the withdrawal layout).

## D67. The email's HTML part is stored (raw_events.html) and is what the receipt parsers read
The ingest endpoint used to keep only the plain-text part, so Venmo (empty plain part, amounts split across elements) and PayPal (plain text loses the layout) could not parse in production even though tests, which fed HTML directly, passed. Migration 7 adds `raw_events.html`; the ingest endpoint stores it (capped at 400 KB); parsers render it with `htmlToText`. A resend of an event stored without HTML fills it in and re-parses it. The tests for these parsers now go through the real signed ingest endpoint.

## D68. Hand-forwards are recognised by the server; Chase's alert email has its own shape
The trust decision for a household member's hand-forwarded mail moved from the receiver script to the server (`src/ingest/forwarded.ts`, applied in `parseEvent`): known user address + authenticated forward + quoted sender on the trusted list. It therefore works on events already stored, via Replay. Chase's own alert email (subject "You made a $N transaction with MERCHANT", body "Date Oct 6, 2026", no time of day) is parsed to a provisional transaction with the date only (`authorized_at` null), alongside the existing sentence-with-time shape. Only one real Chase email was seen, and only its first part: the rest of the body (merchant and amount rows) is unverified.
