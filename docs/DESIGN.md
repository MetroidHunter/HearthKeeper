# HearthKeeper: Design Document

| | |
|---|---|
| **Status** | Draft v0.4, incorporates your answers to the v0.3 questions; adds a discovery track |
| **Date** | 2026-10-03 |
| **Name** | HearthKeeper |
| **Replaces** | `BudgetProgram` + `IFTTTTransactions` spreadsheets, their Apps Script, and the manual month-end process |
| **Built from** | `BudgetProgram_structure_reference.md`, `Code.gs`, `macros.gs`, `IFTTT_Code.gs`, `IFTTT_guess.gs`, `IFTTT_matchnotes.gs`, the Amazon / Venmo / PayPal export skills, your Phase 1 / Phase 2 description, your review answers, and the sample data in the project (the `Projection` blocks, the `Transactions` ledger, and the `IFTTTTransactions` messages) |

**Tag legend**

- **[CONFIRMED-CODE]**: read directly from the scripts
- **[CONFIRMED-USER]**: stated by you
- **[INFERRED]**: my deduction; please verify
- **[PROPOSED]**: a design decision in this document
- **[VERIFY]**: an external fact (price, quota, platform behaviour) that can change; re-check at build time
- **[OPEN-n]**: unanswered question, collected in §21 (none are open at the moment)

### What changed from v0.3

| Area | Change |
|---|---|
| Roadmap (§19) | A **discovery track** starts in week 1: capture every email and notification raw, learn the shapes from a **Shapes page**, then write parsers and **replay** the stored events. A table separates what can be built without the shapes from what waits for them. CSV upload uses a column-mapping wizard so it needs no samples either |
| Wells Fargo (§8.8) | Account granularity doesn't matter to the budget. Only **paired in-system transfers** (moves between Wells Fargo accounts, card payments) are excluded; transfers to outside accounts, like the savings transfer, stay categorized |
| Greenlight (§11) | **Option A confirmed** (allowances charge, funding is a transfer). New **accuracy safeguards** (§11.8) so Marion's and Miracle's money can't land in the wrong category. IFTTT delivers the body only, with the timestamp as a suffix parsed as Pacific, so the capture questions closed |
| Migration (§18) | The `NEEDS CATEGORY` leftovers are resolved during migration through a worksheet, after parity is proven on the unresolved data |
| Confirmed | Venmo cash-outs are split as needed; zero-out adjustments are single-leg write-offs |
| Open questions (§21) | None blocking. A short list of defaults I chose, and what discovery will answer |

---

## 0. Summary

**What:** a small self-hosted web app plus an installable Android app (a PWA) that replaces the two spreadsheets and the manual process around them. It keeps your budgeting concept **exactly as it is** (envelopes that accrue a monthly target from a start date and are drawn down by spending) and removes the friction around it. Transactions are ingested, de-duplicated, categorized, and annotated automatically where possible. When the system can't decide, it asks the right person on their phone, with a good default pre-selected.

**Four structural ideas carry most of the design:**

1. **Raw events are separate from transactions.** Every message, CSV row, or email is stored immutably and *derives* a canonical transaction. Nothing is ever "deleted"; it is ignored with a reason. This replaces `DELETE`, `<TODO>`, and the non-idempotent `convert()`.
2. **Real-money transactions are separate from envelope movements.** The sheet fakes reallocations as transactions named `Reingest…` and hides them with a regex. In the app, transfers between envelopes are their own entity, and accruals are *computed* from budget versions.
3. **Budgets are effective-dated versions, not a History sheet.** Changing a target appends a version; the old value is retained automatically. A **plan** is a draft set of amounts plus an earnings scenario, and it goes live through a diff-and-confirm step. This replaces `History`, `New`, `Projection!D96`, and the manual copy.
4. **Greenlight is a per-profile policy engine.** Each child account has its own category and its own rules for spends, requests, and withdrawals, instead of "Miracle" hard-coded into regexes.

**Cost expectation** [VERIFY]: a few dollars a month. The e2-micro VM is inside GCP's always-free allowance in three US regions; Cloud DNS has no free tier ($0.20 per zone per month plus $0.40 per million queries, so roughly $0.25/month for you); add a domain (~$12/yr) and possibly an external IPv4 charge. The optional IFTTT webhook action appears to need IFTTT Pro. Your time is the real cost; §19 phases the work so each phase is usable on its own.

**Biggest risks:** (1) migration parity: the app must reproduce your lifetime `Current` balances to the cent (§18); (2) Greenlight accounting: the ledger charges funding in some periods and allowances in others, so one rule has to be chosen going forward (§11.2); (3) the receipt emails and Chase email alerts are unseen, so the real-time notes path is unconfirmed (§10); (4) Android background capture can be killed by the OS, so silence detection is mandatory (§8.7).

### 0.1 Decisions log

| # | Decision | Source |
|---|---|---|
| D1 | Android only; PWA for the phone app | [CONFIRMED-USER] |
| D2 | Keep the budgeting concept exactly as is; build rather than fork Actual unless the result ends up the same | [CONFIRMED-USER], [PROPOSED]: build |
| D3 | TypeScript + Lit web components; no React; no MVVM | [CONFIRMED-USER] |
| D4 | Hosting Option A (e2-micro VM, SQLite, nightly backup); no secret manager; no extra encryption | [CONFIRMED-USER] |
| D5 | Notifications verbose by default, real-time when possible, daily catch-all | [CONFIRMED-USER] |
| D6 | CSV download-and-upload is acceptable as the slow lane | [CONFIRMED-USER] |
| D7 | Two Greenlight profiles with a category each: Miracle → Miracle Spending, Marion → Family Support | [CONFIRMED-USER] |
| D8 | Miracle's categorized spends reclassify to the real category with an offset to Miracle Spending; Marion's spends are ignored; both configurable | [CONFIRMED-USER] |
| D9 | Track Greenlight allowances **and** funding (only allowances charge a category; funding is a transfer, D29, §11.2) | [CONFIRMED-USER] |
| D10 | Approved requests: Miracle's act as extra allowance; Marion's prompt for a category | [CONFIRMED-USER] |
| D11 | Non-discretionary categories are immune to rebalance unless above a per-category cushion | [CONFIRMED-USER] |
| D12 | Gig Income pays overages first; the remainder is placed by hand, no templates | [CONFIRMED-USER] |
| D13 | Refunds reduce Spent (net), not Gained | [CONFIRMED-USER] |
| D14 | Income is specified as units/scenarios and assigned to a plan | [CONFIRMED-USER] |
| D15 | No two-person plan approval; no one-tap 50/50 split | [CONFIRMED-USER] |
| D16 | Migrate every transaction since 2020 (snapshot totals only as a fallback) | [CONFIRMED-USER] |
| D17 | Cloud DNS on GCP; buy a domain | [CONFIRMED-USER] |
| D18 | Budget percentage pie chart is wanted | [CONFIRMED-USER] |
| D19 | Open to scrapers, SSO hooks, direct APIs, or a daily AI step if they make data more robust | [CONFIRMED-USER]; my advice in §1.9 |
| D20 | The program is named **HearthKeeper** | [CONFIRMED-USER] |
| D21 | Earnings are per-person lines (salary, work time, effective tax rate) in named scenarios assigned to plans; Miracle's gigs drive Gig Income, not the plan | [CONFIRMED-USER], derived from `Projection` |
| D22 | Receipts and alerts arrive through a dedicated receiver mailbox | [CONFIRMED-USER] |
| D23 | Greenlight request-approval messages are deferred until a sample is captured | [CONFIRMED-USER] |
| D24 | Rebalance covers overages in priority order; auto-propose then review, or assign by hand | [CONFIRMED-USER] |
| D25 | The budget pie shows each category's (or group's) share of the allocation | [CONFIRMED-USER] |
| D26 | Amazon item splits default to `ask` | [CONFIRMED-USER] |
| D27 | Greenlight capture is an Android notification (IFTTT today); one shared parent wallet | [CONFIRMED-USER] |
| D28 | Remaining samples are supplied along the way (superseded by D33: discovery captures them) | [CONFIRMED-USER] |
| D29 | Greenlight option A: allowances charge the profile's category; funding is a tracked transfer. Priority: never charge the wrong category for Marion or Miracle (§11.8) | [CONFIRMED-USER] |
| D30 | Venmo cash-outs are booked on the bank row and split as necessary; Venmo is often, but not always, gig money | [CONFIRMED-USER] |
| D31 | A "zero out" is a single-leg write-off of an envelope's balance (adjustment) | [CONFIRMED-USER] |
| D32 | The `NEEDS CATEGORY` leftovers are resolved during migration | [CONFIRMED-USER] |
| D33 | A discovery phase captures emails and notifications first; build everything shape-independent meanwhile; write parsers once shapes are known; stored events are replayed | [CONFIRMED-USER] |
| D34 | The rows in `IFTTTTransactions` are the exact shape IFTTT sends; adjust later if needed | [CONFIRMED-USER] |
| D35 | The budget doesn't care which Wells Fargo account a transaction is in. Only paired in-system transactions (between Wells Fargo accounts, card payments) are excluded, since no money left the system | [CONFIRMED-USER] |

---

## 1. Constraints and how the design answers them

None of these kill a goal; each shapes how it's built.

### 1.1 "As transactions are made" has three speeds

| Feed | Realistic latency | What it contains | Weakness |
|---|---|---|---|
| **Chase alerts** (email; you get them as SMS today) | seconds to minutes | card purchases, as *authorizations* | provisional; the amount can change when posted (tips, gas pre-auth); no refunds, fees, or payments; alert times are Eastern |
| **Daily notices** (Wells Fargo app notification, ~midnight) | once a day | whatever the notice text contains [VERIFY; need a sample] | coarse |
| **CSV upload** (Chase, Wells Fargo) | whenever you do it | everything, as *posted* | manual, but acceptable to you (D6) |

So the design has a **fast lane** (alerts create *provisional* transactions and trigger prompts), a **daily lane** (batched prompts and the digest), and a **slow lane** (CSV, authoritative). They reconcile (§8.6). Real-time prompts are realistic for Chase and Greenlight. Wells Fargo activity (salary, mortgage, bills) is mostly recurring and rule-categorizable [INFERRED], so the daily lane is enough.

### 1.2 Android PWA, plus on-device capture

A PWA installed to the home screen gives you an icon, web push, and tap-to-categorize from one codebase hosted on the same server. On Android, Chrome supports web push and notification action buttons [VERIFY], so the prompts can carry one-tap answer buttons.

A PWA cannot read other apps' notifications. For the sources that only exist as notifications (Greenlight push, possibly Wells Fargo's daily notice), a small on-device automation posts them to the server (§8.5). That's the one place Android-specific plumbing is unavoidable; a native app would not remove it.

### 1.3 Greenlight: modeled from your real messages

Two profiles, per-profile category and policies, allowances and funding both tracked (§11). Reading the actual notifications and the ledger turned up one real ambiguity: **which event charges the bucket**. The sheet has charged bank funding in some periods and allowances in others (§11.2). Everything else about Greenlight is settled except request-approval messages, which are deferred until you capture one.

### 1.4 For Amazon / Venmo / PayPal the category depends on the note, and may be several

An Amazon charge can span Groceries, Pets, and Home Improvement. So the note comes first, then **item-level splits** (§10.5). One prompt asks for note and category together when nothing can be inferred.

### 1.5 "Without specifying the history" can't be entirely free

A budget change has to say *from when*. The default is "this month," so the common case is zero-friction. A retroactive change is allowed but explicit, with the balance impact shown (§12.4). Today, skipping the `History` row silently re-prices the past; the app never does that silently.

### 1.6 Parity first, with two deliberate deltas

The app must reproduce the sheet's numbers before it improves them. Two deliberate differences:

- **Refunds** reduce Spent (D13); the sheet counts them as Gained.
- **Date windows** are any range, not just this and last month.

Both are reproducible exactly for the parity test (§18.3) by running a "sheet-compatible" query.

### 1.7 Build vs adopt: build

You were open to forking Actual Budget if the result would be exactly what you want. I'd still build, for four reasons:

- Actual is built around per-month budgeted amounts with rollover, on a local-first sync architecture [VERIFY]. Your model (accrual from a start date, plans, versioned history, per-category Greenlight handling, item splits) would mean rewriting its core, so a fork would carry its constraints without its benefits.
- Its stack is React-based [VERIFY]; you've ruled that out.
- Merging upstream changes into a heavily modified fork is a permanent tax.
- The parts worth borrowing are ideas (rules with preview, de-dup, SimpleFIN sync), not code.

### 1.8 Verbose first, taper later

You'd rather start noisy and pare back (D5). Defaults flip accordingly (§9.4, §15.3). Seeded rules start in `suggest` mode (a prompt with the answer pre-selected), and you promote them to `auto` once you trust them. The one exception is the three-month backlog, which is a batch review screen, not hundreds of pushes.

### 1.9 Direct bank connections: my advice

You offered a scraper, SSO hook, direct API, or daily AI step if it makes the data side more robust. My honest view:

| Option | Verdict |
|---|---|
| **Scraping Chase / Wells Fargo logins** | Not recommended. MFA, bot detection (the Amazon skill already hit it on "Load More"), terms of service, and stored bank credentials make it the most fragile and riskiest dependency in the system. Failure is silent unless monitored. |
| **Direct bank API** | Neither bank offers a personal-use API that I'm aware of [VERIFY]. |
| **Aggregator (SimpleFIN, ~$15/yr)** | Optional, later (§8.4). One read-only dependency with native IDs, daily refresh. Worth it only if CSV upload starts to feel like friction. |
| **CSV upload** | Primary slow lane. Cheap, robust, no credentials. Effort goes into upload UX (§8.3). |
| **Daily AI step** | Useful for *verifying and parsing*, not for fetching: (a) a fallback parser that proposes fields from emails the deterministic parsers don't recognize, (b) item-level category suggestions, (c) a daily "does this look right" check for coverage gaps and anomalies. Suggestion-only, human-confirmed (§9.8). It sends financial text to a third-party API, a privacy trade-off you should consciously accept or skip. |

---

## 2. Goals, non-goals, success criteria

### 2.1 Your goals and where they're addressed

| # | Goal | Addressed in |
|---|---|---|
| 1 | Auto-categorize as made; otherwise prompt the purchaser on their phone | §8, §9, §15 |
| 2 | Amazon / PayPal / Venmo notes determined at transaction time, else prompt | §10, §15 |
| 3 | Ignore "normal" Greenlight spends; return money to the associated bucket | §11 |
| 4 | Associate each Greenlight account with a budget category | §11.3 |
| 5 | Update budgets without History-row friction; plan CRUD; one-click go-live with confirm and history | §12 |
| 6 | Spend metrics by category and timeframe, and by store or store group | §9.2, §14 |
| 7 | Better trend visualizations, including the budget percentage pie | §14 |
| + | Phone app: recent transactions, favorite categories, items needing attention | §15 |
| + | Earnings specified as units and assigned to a plan | §12.4–12.5 |
| + | Every sheet piece accounted for | §5 |

### 2.2 Non-goals (v1)

- Multi-tenant / multi-household product. Two users, one household.
- Investment tracking, bill pay, or storing bank credentials.
- `Miracle Budget`, `MiracleLoanCalculator`, `DepreciatingGoods`, `Grandma` stay in Sheets for now (out of scope per the structure reference).
- Changing how you budget. The envelope / accrual model is preserved (D2).

### 2.3 Success criteria [PROPOSED]

| Criterion | Target |
|---|---|
| **Parity** | At cut-over, every category's `Current`, lifetime `Months`/`Total`, and monthly Spent/Gained match the sheet to the cent via the sheet-compatible query (§18.3) |
| **No lost transactions** | Every account shows a coverage indicator; stale accounts are flagged. A three-month silent backlog should be impossible |
| **Automation** | Auto-categorization rate and override rate are tracked in-app. Starting targets (tune with real data): ≥ 85% resolved without a prompt once rules are promoted, ≤ 3% overridden |
| **Month-close effort** | Only phone prompts as they occur plus the close wizard (§13.4) |
| **Idempotency** | Re-importing any file or re-running any matcher never changes a user's manual decision |
## 3. The current system, in brief

### 3.1 Model [CONFIRMED-FORMULA / CONFIRMED-CODE]

An envelope / accrual budget. Each category accrues its monthly target for every month from its `Start Date` through the current month (inclusive); spending draws it down:

```
Budget!Current = lifetime net Transactions for the category (Reingest rows included)
               + lifetime accrued budget (historicalBudget(): months × target, across History segments)
```

### 3.2 Process (your description) mapped to this document

| Your step | Replaced by |
|---|---|
| Download Chase + Wells Fargo CSVs since last time − 2 days | Saved import profiles, overlap-safe de-dup, optional aggregator (§8.3–8.4) |
| Format CSVs to match IFTTTTransactions | Profile column mapping; no manual formatting |
| Run Greenlight classifier, manually remove unneeded rows | Greenlight policy engine with per-profile dispositions (§11) |
| Run categorizer (`guess`), fix blanks by hand | Merchants + rules + phone prompts (§9) |
| Chrome skill dumps Venmo/Amazon/PayPal; run notes matcher | Email-based real-time notes + the same skill CSVs as bulk path; global matcher (§10) |
| Copy to `Transactions` | Not needed; one ledger |
| Fix categories; split Brys / Miracle | Inbox + splits editor (§6.7) |
| Reingest pass: move money from surplus to overspent | Close wizard: Gig Income pays overages, then eligible donors (§13.1–13.2) |
| Distribute Gig Income | Pool pays overages first; the remainder is placed by hand (§13.1–13.2) |
| Last pass: notes present, categories set, `NeedsCategory` = 0 | Automated close checklist (§13.4) |

### 3.3 Pain points evidenced in the code and process

1. **Not idempotent.** `convert()` overwrites B:E on every run, wiping manual category edits [CONFIRMED-CODE].
2. **Magic strings as state.** `DELETE`, `<TODO>`, blank, and Notes prefixes `???`, `FLAG:`, `?? AMBIGUOUS` all encode workflow state in text.
3. **Substring guessing.** `_guessAtCategory` is a first-match `switch(true)` of `includes()` checks. Short tokens risk false positives (illustrative: `arco` also appears in "Marco's"; `ulta` in "consultant"). Amount rules compare strings (`price == '-150'` won't match `-150.00`), and the State Farm rule keys off whether the description contains `19` or `15` [CONFIRMED-CODE].
4. **Notes matcher quirks.** Candidates from all three source tabs compete for every row, so an Amazon and a Venmo charge of the same amount look ambiguous even when the bank descriptor names one of them. Sign must match or it silently fails; `?? AMBIGUOUS` text blocks re-runs; ambiguous candidates aren't consumed [CONFIRMED-CODE].
5. **Hard-coded names / time hacks.** "Miracle" is hard-coded in the return and withdraw regexes. DST is checked at *run time*, not at the alert's date [CONFIRMED-CODE].
6. **Budget change friction.** A target change needs a `History` row with a *real date*, then a manual copy from `New`. Skipping it silently re-prices the past [CONFIRMED-USER / CONFIRMED-CODE].
7. **Reallocations are fake transactions** distinguished by a regex on Name (`[rR]eingest`).
8. **Two-month window.** Spent/Gained exist only for this and last month; no trends.
9. **Positional macro.** `SplitCost` depends on the active cell and a `Split Total` column.
10. **Money as strings/floats.** `historicalBudget` returns `toFixed(2)` strings that `Budget!D` coerces.
11. **No audit trail** and **no staleness signal**: the data is currently ~3 months behind and nothing says so.

---

## 4. Design principles [PROPOSED]

1. **Never destroy information.** Raw events are immutable; "ignored" is a state with a reason, not a delete.
2. **Money is integer cents; time is explicit.** Local dates in `America/Los_Angeles`; timestamps in UTC; Chase's Eastern times parsed with a real tz database.
3. **Every manual workaround becomes a first-class thing.** Flags, transfers, plans, and ignored-reasons are fields and tables, not text conventions.
4. **Automation proposes, you dispose, the system learns.** Every manual answer can become a rule, with a backtest showing what it would have done historically.
5. **Idempotent everywhere.** Imports, parsing, and matching can be re-run without changing human decisions.
6. **Ask once, with a good default, and start verbose.** Everything uncertain prompts at first; you promote rules to silent as you trust them.
7. **Explain every automatic decision** ("categorized by rule #184", "note matched Amazon order 112-…").
8. **Cheap and simple to operate.** One small server, one database file, backups to object storage.
9. **Parity first.** Reproduce the sheet's numbers, with documented deltas, before improving them.

---

## 5. Traceability matrix: every sheet piece accounted for

| Current piece | What it does today | New home | Notes |
|---|---|---|---|
| `Budget!A` Parent | VLOOKUP from `List` | Category → group | Real FK, not a lookup |
| `Budget!B:C` Name, target | Input | Budget page, category's current version | Edit = append version (§12.2) |
| `Budget!D` Current | Lifetime txns + accrued | Computed balance (§6.1) | Must match to the cent |
| `Budget!E:H` Spent/Gained this/last month | Windowed by `TODAY()` | Period columns for *any* two periods | Plus Net (§14) |
| `Budget!B2` Expected income | `=Projection!D96` | The plan's **earnings scenario** (§12.5) | Snapshotted when a plan goes live |
| `Budget!C2`, `C3` Allocated, Unallocated | `SUM(C5:C)`, `B2−C2` | Live header on Budget and Plans | No open-ended-range hazard |
| `New` sheet | 2 scratch areas | **Budget Plans**: unlimited drafts (§12.4) | |
| Copy `New` → `Budget` | Manual | **Make live** with diff + confirm (§12.4) | |
| `History` + `Internal!D:F` | Old amounts + stop month, sorted mirror | `category_budget_versions` + history view | Date-ordering bug class disappears |
| `historicalBudget()` | Accrual engine | Balance service (§6.1) | Tested against it in migration |
| `List` Name/Parent/Start/Deprecated | Category registry | `categories`, `category_groups`, `status` | Rename-safe (stable IDs) |
| `List!F:G` Usages | Count per parent | Group page counts | Informational |
| `Internal!A:B` | Lifetime sum per category | Balance query | |
| `Internal!M:W` | Monthly Spent/Gained | Period reports | |
| `Internal!Y` Validation list | Non-deprecated names | Category picker (active only) | |
| `Transactions` | Master ledger | `transactions` + `transaction_splits` | |
| `Split Total` + `SplitCost` | 50/50 split via 2 rows | Splits editor (N-way, any ratio) (§6.7); item-level splits for Amazon (§10.5) | No one-tap 50/50 (D15) |
| `Reingest…` rows | Fake transactions | `envelope_transfers` (§13) | Excluded from Spent/Gained by *type* |
| `[Category] Ingest` (2020) rows | Legacy | Imported as `legacy` adjustments (§18.2) | Inspect |
| Gig Income pass | Manual reingests | Close wizard: pool pays overages first, remainder placed by hand (§13.1–13.2) | No templates (D12) |
| Over/under reconciliation | Manual reingests | **Rebalance** with discretionary flag + cushion (§13.1) | |
| `NeedsCategory` = 0 check | Manual | Inbox count + close checklist (§13.4) | [INFERRED: you mean "no uncategorized transactions"; confirm] |
| Blank-category txns | Hit no envelope | `needs_category` state; blocks close | |
| IFTTT col A raw text | Notification text | `raw_events` (§8.2) | Immutable |
| `convert()` 6 handlers | Parse + write B:E | Per-source parsers (§8.5); the name is parsed from the message, not hard-coded | Fixture-tested |
| `NEEDS CATEGORY` category (Goods, $0 budget) | Parking spot for unresolved transactions; the `NeedsCategory is 0` check | The `needs_category` state (a null-category split); migration maps rows in it there (§18.2) | Same lifetime totals; ~−$1.5k of 2024–25 leftovers to resolve |
| `Reingest` / `Reignest` / `Zero Out …` rows | Reallocations by naming convention (the regex misses some) | Envelope transfers and single-leg adjustments (§13.3, §18.2) | |
| `GREENLIGHT APP` bank rows | `DELETE` in the guesser, but charged to Miracle Spending in the ledger | Funding transfer into the wallet (§11.2) | Decided: option A (D29) |
| Card payments and Wells Fargo ↔ Wells Fargo moves (both legs `DELETE`d by hand or rule) | Removes both legs of a paired transaction | **Paired in-system transfers**, classified by descriptor and verified by pairing (§8.8) | Transfers to outside accounts stay categorized |
| Chase SMS alerts (read by eye today) | Not ingested | Chase email alerts → provisional transactions (§8.5) | New |
| Greenlight Marion | Unparsed | A second Greenlight profile → Family Support (§11) | New |
| IFTTT → Sheets row | Greenlight capture | On-device capture → webhook (§8.5) | Sheet removed from the chain |
| `_guessAtCategory` | Substring switch | Merchants + rules (§9) | Seeded mechanically |
| `DELETE` / `<TODO>` / blank | Text states | `ignored(reason)` / `needs_category` | |
| `matchExternalNotes()` | Greedy 2-pass | Global assignment matcher (§10.3) | Source-aware |
| Notes `???` / `FLAG:` / `AMBIGUOUS` | Text conventions | `flagged`, `note_state` fields | |
| Amazon/Venmo/PayPal Chrome skills | Scrape → `Date,Amount,Note` CSV | Kept as bulk/backfill path; email path added (§10.1) | Same CSV format accepted |
| `Insights` (keyword search) | Out of scope in sheet | **Explore** page (§14.3) | Replaces it |
| `Year` | Per-year category table | Pivot report (§14.2) | |
| Phase 2 "last pass" | Manual | Close checklist (§13.4) | |
| `Projection` (first columns only) | Income / savings scenarios | **Earning units and scenarios** (§12.5) | Layout derived from the sheet (§12.5) |
| `Miracle Budget`, `MiracleLoanCalculator`, `DepreciatingGoods`, `Grandma` | Side trackers | Stay in Sheets in v1 | Candidates later |

---


---

## 6. Domain model

### 6.1 Two ledgers and one formula

- **Transactions**: real money moving in or out of real accounts, plus the Greenlight reclassification entries (§6.2). Each has one or more **splits** assigning amounts to categories.
- **Envelope movements**: reallocations between categories (**transfers**) and the monthly **accrual** (computed, never stored as rows).

```
balance(c, asOf) =  Σ split.amount           for splits in category c, txn date ≤ asOf
                  + Σ leg.amount             for transfer legs in category c, date ≤ asOf
                  + accrued(c, asOf)

accrued(c, asOf) =  Σ monthly_amount(c, m)   for each month m from start_month(c) through month(asOf), inclusive

monthly_amount(c, m) = amount of the budget version of c with the greatest effective_month ≤ m   (0 if none or retired)
```

This is exactly `Budget!Current` (lifetime transactions *including* reingests, plus lifetime accrual), expressed without a regex. **Spent / Gained** for a period use **splits only**, never transfers or accruals, which is what the sheet's `[rR]eingest` exclusion approximates.

### 6.2 Transaction kinds

| Kind | Examples | Affects envelopes? | Shown in spend reports? | Split invariant |
|---|---|---|---|---|
| `spending` | groceries, restaurants | yes | yes | Σ splits = amount |
| `income` | salary, gig income, **Venmo / PayPal cash-outs**, reimbursements | yes (pool / reference rules, §6.3) | as Gained, or reducing Spent where the receipt is a reimbursement | Σ splits = amount |
| `internal_transfer` | Chase payment, bank → Greenlight wallet funding (under option A, §11.2), paired transfers between your own accounts (§8.8) | no | no | none (no splits) |
| `greenlight_allowance` | allowance wallet → profile | yes: debits the profile's category | yes, under that category | Σ splits = amount |
| `greenlight_return` | profile → wallet | yes: credits the profile's category | yes | Σ splits = amount |
| `greenlight_reclass` | Miracle buys groceries | yes: moves the spend to the real category (§11.4) | yes | **Σ splits = 0** |
| `ignored` | Marion's vendor spends, notification noise | no | no | none |

`ignored` and `internal_transfer` always carry a **reason** and remain visible under a "Hidden" filter with a restore button. Nothing is deleted.

**Why `greenlight_reclass` sums to zero:** the real money was already charged to the profile's category when the allowance moved (D9). A reclassification only *re-attributes* part of that charge, so it must not change the household total. Example: Miracle spends $30 at a grocery store → splits `Groceries −30`, `Miracle Spending +30`. Groceries shows $30 spent; Miracle Spending's net spend drops by $30.

### 6.3 Category fields and kinds

| Field | Meaning |
|---|---|
| `kind` | `expense`, `income_pool`, `income_reference` |
| `discretionary` | bool; can donate to a rebalance (§13.1) |
| `cushion_cents` | for non-discretionary categories: the balance that must remain before any surplus is eligible to move |
| `favorite` | per user (§15.1) |
| `start_month`, `status` | accrual start; `active` / `retired` |

| Kind | Examples | Behaviour |
|---|---|---|
| `expense` | Groceries, Eating Out | normal envelope |
| `income_pool` | Gig Income | positive receipts accumulate; used to pay overages first, remainder placed by hand; should be 0 at close (§13) |
| `income_reference` | Salary, Hourly Income | balance shown as N/A (matches your hard-coded `N/A`) [CONFIRMED-USER]; receipts still recorded |

### 6.4 Money, signs, time

- **Cents as integers.** No floats, no `toFixed` strings.
- **Sign convention unchanged:** expenses negative, income/credits positive.
- Each transaction stores `occurred_on` (local date), `posted_on` (nullable until posted), and `authorized_at` (UTC timestamp, when known).
- **Month boundaries** are in `America/Los_Angeles`. The DST problem disappears because Chase alert times are parsed as `America/New_York` with a tz library, at the alert's own date. For Greenlight, the timestamp is the suffix IFTTT appends, parsed as Pacific exactly as the sheet does today (§11.1); other captures use the device or arrival time.

### 6.5 Transaction lifecycle

```
raw_event ──parse──▶ provisional ──posted record matches──▶ posted
                         │                                      │
                         └── no match after N days ─▶ stale ────┘ (flagged in Inbox)

review state:  auto_categorized | needs_category | user_confirmed
note state:    not_needed | auto_matched | awaiting_note | ambiguous | needs_note | user_provided
```

### 6.6 Budget versions

`category_budget_versions` rows are `(category, monthly_amount, effective_month)`, append-only. Your `History` semantics map in directly, since "Month Stopped Using" is already *exclusive: the first month the new amount applies* [CONFIRMED-CODE]. Migration algorithm in §18.2.

### 6.7 Splits

Every `spending` / `income` transaction has ≥ 1 split; the invariant is `Σ splits = transaction amount`. The `Split Total` column and the `SplitCost` macro disappear, and per D15 there is no one-tap 50/50. The splits editor offers arbitrary amounts, percentages, and N-way. Splits come from three places:

- **You**, in the editor (rare for Brys/Miracle, per your note).
- **Item-level proposals** for Amazon and other wrapper sources (§10.5).
- **Greenlight reclassification** (§11.4).

Each split records its `origin` (`user`, `rule`, `item`, `greenlight_reclass`) so you can always see why it exists.

---

## 7. Data model sketch [PROPOSED]

SQLite; the sketch is database-neutral. `*_cents` columns are integers. Every table has `id`, `created_at`, `updated_at`; mutable user-facing tables have a `version` counter for optimistic locking.

### 7.1 Identity and structure

```
users(id, name, email, push_subscriptions[], notify_prefs_json)
accounts(id, name, institution, type[credit_card|bank|greenlight_wallet|venmo|paypal|amazon|cash],
         owner_user_id?, shared bool, in_system bool, last4?, sync_method, last_synced_at, import_profile_id?)
category_groups(id, name, sort)                         -- your "Parent"
categories(id, group_id, name, kind[expense|income_pool|income_reference],
           discretionary bool, cushion_cents?, overage_priority?, start_month, status[active|retired], retired_month?, sort)
favorites(user_id, category_id, sort)
```

Seed accounts (from your answers): Chase Prime Visa (shared card, one account); Wells Fargo (three debit accounts, **Brys**, **Miracle**, **Home**, which only matter to ingestion, never to the budget, D35); Greenlight wallet (parent wallet); Venmo and PayPal per person (Brys, Miracle); Amazon (one shared account).

### 7.2 Budgets, earnings, plans

```
category_budget_versions(id, category_id, monthly_cents, effective_month,
                         plan_id?, reason?, created_by, created_at)   -- UNIQUE(category_id, effective_month)
earning_scenarios(id, name, notes)
earning_scenario_lines(id, scenario_id, person_user_id?, label, annual_salary_cents, work_time_pct,
                       tax_rate_pct, recurring bool)       -- net = salary × work_time × (1 − tax_rate); see §12.5
budget_plans(id, name, status[draft|live|archived], scenario_id?, income_snapshot_cents?,
             base_note, created_by, made_live_at?, made_live_by?, effective_month?)
budget_plan_items(plan_id, category_id, monthly_cents)
```

### 7.3 Ingestion

```
raw_events(id, source[chase_alert|chase_csv|wf_csv|simplefin|greenlight_msg|wf_notice|amazon_receipt|
                      venmo_receipt|paypal_receipt|notes_csv|manual], channel[email|device|upload|api],
           received_at, ingest_token_id, payload_text_or_json, dedupe_key UNIQUE,
           parser_version, parse_status[ok|unrecognized|error|llm_proposed], error?)
ingest_tokens(id, label, user_id?, channel, secret_hash, last_seen_at, expected_cadence)
import_profiles(id, account_id, column_map_json, date_format, sign_rule, skip_rows, header_signature)
```

### 7.4 Transactions

```
transactions(id, account_id, owner_user_id?, kind, status[provisional|posted|stale|void],
             occurred_on, posted_on?, authorized_at?, amount_cents,
             descriptor_raw, descriptor_clean, merchant_id?, location_hint?,
             review_state, decided_by[rule|user|merchant_default], decided_rule_id?,
             note?, note_state, note_source?, flagged, flag_reason?,
             ignored_reason?, superseded_by?, source_event_ids[])
transaction_splits(id, transaction_id, category_id?, amount_cents, memo?, origin[user|rule|item|greenlight_reclass])
external_notes(id, source[amazon|venmo|paypal], account_id, occurred_on, amount_cents, note, counterparty?,
               order_ref?, shared_note bool, raw_event_id, matched_txn_id?)
external_note_items(id, external_note_id, name, qty, amount_cents, category_suggestion_id?)
```

### 7.5 Merchants and rules

```
merchants(id, name, review_state[reviewed|unreviewed], default_category_id?, default_mode[auto|suggest|ask])
merchant_aliases(id, merchant_id, match_type[contains|word|starts_with|regex], pattern, priority)
merchant_groups(id, name)                 -- user-curated, e.g. "Makeup retailers"
merchant_group_members(group_id, merchant_id)
rules(id, enabled, priority, match_json, action_json, mode[auto|suggest|ask],
      origin[legacy_guesser|user|learned], hit_count, clean_confirmations, override_count, last_hit_at, notes)
```

### 7.6 Envelope movements and Greenlight

```
envelope_transfers(id, occurred_on, kind[reconcile|pool_payment|placement|manual|adjustment|legacy], memo, created_by)
envelope_transfer_legs(id, transfer_id, category_id, amount_cents)        -- Σ legs = 0, except kinds adjustment and legacy
greenlight_profiles(id, display_name, name_pattern, category_id, wallet_account_id,
                    spend_policy[ignore|reclassify], request_policy[as_allowance|ask_category],
                    withdraw_policy[ask|debit_category|ignore], active)
greenlight_requests(id, profile_id, amount_cents, requested_at, raw_event_id,
                    status[pending|funded|declined|stale], funded_txn_id?, chosen_category_id?)
```

### 7.7 Operations

```
close_periods(id, through_date, closed_by, closed_at, snapshot_json)      -- optional soft lock
audit_log(id, entity, entity_id, action, before_json, after_json, actor, at)
notification_log(id, user_id, kind, ref_id, sent_at, answered_at?)
```

### 7.8 Invariants enforced in code and tests

- `Σ splits = transaction.amount_cents` for `spending`, `income`, `greenlight_allowance`, `greenlight_return`.
- `Σ splits = 0` for `greenlight_reclass`; every reclass references the originating Greenlight spend event.
- `Σ transfer legs = 0` for `reconcile`, `pool_payment`, `placement`, `manual`. `adjustment` (zero-out / write-off) and `legacy` may be single-leg, and reports show total adjustments separately.
- A category can't have two versions with the same `effective_month`.
- A retired category's last version is `0`.
- Plans can only reference active categories.
- A Greenlight request never posts a charge by itself (§11.5).

---

## 8. Ingestion

### 8.1 Sources

| Source | Fast lane | Daily / slow lane | Owner / purchaser | Notes |
|---|---|---|---|---|
| **Chase Prime Visa** (one shared card) | Chase **email** alert → provisional txn [VERIFY: Chase can email the same alerts you get as SMS] | CSV upload | unknown → prompt both (§15.3) | alert times are Eastern |
| **Wells Fargo** (three debit accounts, treated as one source) | optional: the app's ~midnight notice, via device capture, if it carries transaction text [VERIFY; discovery will show] | CSV upload | unknown → both of you | paired transfers among the accounts and card payments are `internal_transfer` (§8.8) |
| **Greenlight** (Miracle, Marion) | Android notification (IFTTT's notification trigger today) via device capture | bank CSV shows only the funding rows (`GREENLIGHT APP`) | the parent | wallet ↔ profile flows only (§11) |
| **Amazon** (one shared account) | order / shipment emails → `external_notes` + items [VERIFY: need samples] | Chrome skill CSV | both | multi-shipment orders; points-paid phantom rows |
| **Venmo** (Brys, Miracle) | receipt emails [VERIFY] | Chrome skill CSV | per person | emoji memos; two logins |
| **PayPal** (Brys, Miracle) | receipt emails [VERIFY] | Chrome skill CSV | per person | personal vs business; foreign currency |

### 8.2 Pipeline

```
 source ─▶ raw_events (immutable, de-duplicated by dedupe_key)
              │
              ▼
          parser (per source, versioned, fixture-tested)
              │  unrecognized ─▶ "Unrecognized messages" list (never silently dropped);
              │                  optional LLM fallback proposes fields for you to confirm (§9.8)
              ▼
          canonical record ─▶ de-dupe / reconcile with provisional ─▶ transaction
              │
              ▼
          classify kind (internal transfer? Greenlight? wrapper source?)
              ▼
          merchant resolve ─▶ notes + item match (wrapper sources) ─▶ rules ─▶ decide:
              auto-apply │ suggest │ ask  ─▶ review_state + notification decision (§15.3)
```

Everything after the parser is **idempotent**: re-running enrichment on a transaction never overwrites a `user`-decided field.

**Capture first, parse later.** Raw events are stored before any parser exists for them and can be **replayed** through a new parser at any time. That is what makes the discovery track (§19.2) safe: anything captured now is parsed retroactively once its shape is known.

### 8.3 CSV upload (primary slow lane)

- **Saved profile per source, built by a column-mapping wizard.** On the first upload of a layout you map the columns once (date, amount, description, and so on) and the profile is saved, keyed by the header signature, so later uploads need no formatting and no samples are needed up front. Chase and Wells Fargo layouts differ; that's the only reason for two profiles. Wells Fargo's three accounts share one layout, and **which account a file came from doesn't matter to the budget** (D35): de-dup is scoped to the institution, and an account tag is optional.
- **Drag-and-drop, multiple files at once.** The preview before commit shows counts of *new*, *already imported*, *matches a provisional*, *will auto-categorize*, *needs attention*.
- **Overlap-safe de-dup** (replaces "since last time − 2 days"). CSV rows have no stable IDs, so the fingerprint is `(account, date, amount, normalized descriptor)`, and de-dup is a **multiset difference**: if the DB already holds N rows with that fingerprint and the file has M ≥ N, import M − N. Two identical coffees on one day are preserved; re-importing a wide window is harmless. Import as far back as you like.
- **Coverage indicator** per institution (and per account if you tag them): last transaction date, last upload, and a stale badge after a configurable number of days. This is the direct fix for a three-month silent backlog.
- **Backlog mode:** uploading a large range opens a batch review (grouped by merchant, bulk-confirm) instead of sending a push per row.

### 8.4 Aggregator (optional, later)

SimpleFIN Bridge, about $15/yr, read-only, roughly daily refresh [VERIFY: pricing and refresh cadence from simplefin.org]. It gives native IDs (clean de-dup) and removes CSV downloads. The ingestion layer treats it as just another source adapter, so it can be added, swapped, or skipped without touching anything else. I'd only add it if CSV upload starts to feel like friction (D6, §1.9).

### 8.5 Alerts, receipts, and device capture

**Receipts and alerts by email (dedicated receiver mailbox).** You want a forwarding path that doesn't muddle the parser with your main inbox. Proposed:

1. Create one dedicated Gmail account used only as the **receiver mailbox**.
2. Each person's Gmail gets filters that forward only the relevant mail (Amazon orders and shipments, Venmo, PayPal) to it. Chase's alert email address is set to the receiver directly.
3. A small Apps Script in the **receiver account only** (free, nothing touches your main mailboxes) runs on a time trigger every few minutes, POSTs new labelled messages to `/ingest/email` with an HMAC-signed token, then relabels them.
4. **Owner detection** uses the original recipient header preserved on forwarded mail (Brys's Venmo vs Miracle's Venmo) [VERIFY on a real forwarded sample]. Chase alerts delivered to both of you collapse by `dedupe_key`.

The alternative is a real inbound mail server on the VM. GCE blocks outbound port 25 but can *receive* mail [verified], so inbound-only works. It adds an MX record, spam handling, and TLS to maintain, which is why I prefer the Gmail receiver. Revisit only if Apps Script quotas become a problem.

**Device capture (Greenlight, maybe Wells Fargo).** These exist only as Android notifications. A single on-phone automation posts each notification as `{app, title, text, device_time}` to `/ingest/device` with a per-device token. Options:

| Option | Notes |
|---|---|
| **IFTTT with a webhook action** | You already use IFTTT; swap the Sheets action for "Make a web request". That action appears to require IFTTT Pro [VERIFY]. Polling of some triggers is slower on the free plan. |
| **MacroDroid or Tasker** | Native notification trigger, HTTP request action, no cloud middleman. One-time purchase or free tier [VERIFY]. |

IFTTT delivers the notification **body only**, with `on <date> at <time>` appended [OBSERVED]. Your rows are the exact shape, so the Greenlight parsers can be built now (D34). Keep the existing Sheets applet running and add a second applet with the webhook action (**dual-run**, §19.2); the webhook body just carries IFTTT's text and timestamp ingredients, and the endpoint stores whatever arrives, so the ingredient names can be adjusted later.

Android battery optimization can kill background automations, so §8.7's silence alerts are mandatory. If a notification's title or app name is ever needed, MacroDroid or Tasker can supply it; that's an adjustment, not a redesign.

**Parsers** exist per source with test fixtures from real, redacted samples, so a format change fails a test instead of failing silently. The Greenlight fixtures already exist in your sheet (§11.7); the others come from the discovery track (§19.2).

### 8.6 Reconciling provisional and posted

A **provisional** transaction (from an alert) counts toward balances immediately, with a "pending" marker, so the phone's "remaining" is live. When a posted record arrives:

1. Same account.
2. Amount equal; or, for tip-prone and pre-auth merchants (restaurants, gas), within a configurable tolerance when there's exactly one candidate.
3. Posted date within a few days of authorization.
4. Descriptor similarity (token overlap) above a threshold.
5. Best-score one-to-one assignment; ties stay unmatched and are flagged.

On a match, the posted record **supersedes** the provisional one and inherits the category, note, and flags (your phone answers are never lost). A provisional with no posted match after N days becomes `stale` and appears in the Inbox.

### 8.7 Failure handling

- **Ingest health page:** last event per source and per token, parse failures, unrecognized count.
- **Silence alerts:** a push if any source has been quiet longer than its `expected_cadence` (a phone that stopped forwarding Greenlight notifications is the likeliest failure). Each device automation also sends a periodic heartbeat.
- **Dead-letter view** for events that failed to parse, with a "reparse" button after a parser fix.
- **Coverage gaps** are compared against CSV uploads: an alert-sourced day with no posted match after a CSV covering that day is flagged.
- **Shape drift:** the Shapes page (§19.2) keeps running after launch, so a changed Chase, Greenlight, or receipt format appears as a new cluster instead of silent loss.

### 8.8 Paired in-system transfers

Wells Fargo account granularity doesn't matter to the budget (D35). What matters is that transactions happen, and that money moving *within* your system is never counted as spending or income.

- **In-system accounts:** the Chase card, the three Wells Fargo accounts, and the Greenlight wallet. Everything else is outside.
- **Pairing rule:** two rows on in-system accounts with opposite signs and equal amounts within about three days are linked as one `transfer_group` and both legs become `internal_transfer`, with no budget effect. It covers moving money from one Wells Fargo account to another and paying the credit card from Wells Fargo (the Wells Fargo debit leg and Chase's "payment thank you" credit leg).
- **Descriptor rules classify a leg even when its partner hasn't been imported yet.** Today's `DELETE` rules do this for both card-payment legs (`chase credit crd`, `payment thank you…`) [CONFIRMED-CODE]. Pairing then *verifies*: a leg whose partner never appears, once the other source's data has caught up past that date, is flagged for review instead of silently dropped.
- **Equal-and-opposite is not enough on its own.** A refund that happens to match a purchase on another account is not a transfer. Within Wells Fargo, pairing needs a transfer-like descriptor or your confirmation (verbose by default); across institutions it needs descriptor evidence.
- **Transfers to accounts outside the system are real spending.** `RECURRING TRANSFER TO … WAY2SAVE SAVINGS` is categorized `Miracle Savings Transfer` today [OBSERVED], because that money leaves the budgeted accounts. Pairing never touches these.
- **Greenlight funding** follows the same logic: under option A it's an `internal_transfer` into the wallet (§11.2).
- **Account tags are optional.** A Wells Fargo upload can be tagged with its account, but nothing in the budget depends on it (§8.3).

---

## 9. Categorization

### 9.1 Order of operations

1. **Kind classification:** internal transfer? (card payment, Greenlight funding, transfers between your own accounts) → `internal_transfer`, no further steps. A Venmo or PayPal cash-out is *not* one: it is income or a reimbursement and is categorized (§10.2).
2. **Source-specific classifier:** Greenlight events go to the profile's policies (§11).
3. **Merchant resolution** (§9.2).
4. **Wrapper sources** (Amazon / Venmo / PayPal): attempt the note match first (§10); rules can then use the note, counterparty, and amount.
5. **Rules** (§9.3) → decision (§9.4).
6. Otherwise `needs_category`, and a prompt if the notification policy says so.

### 9.2 Merchants, aliases, and groups (spend "by store")

Your goal: *"Sephora accounts for all Sephoras, not just Sephora #182."*

- **Descriptor cleaning** strips store numbers (`#182`), trailing city/state, and processor prefixes (`SQ *`, `TST*`, `DD *`, `PAYPAL *`, `GOOGLE *`, `AMAZON MKTPL*`), and keeps the store number in `location_hint` in case per-location analysis is ever wanted. Wells Fargo debit rows need more [OBSERVED]: prefixes like `PURCHASE AUTHORIZED ON 07/07`, `RECURRING PAYMENT AUTHORIZED ON …`, `ATM WITHDRAWAL AUTHORIZED ON …`, and suffixes like `S301189151997605 CARD 4481`. The *authorized-on* date is the true purchase date (the CSV date is the posting date), and the card ending identifies the debit card.
- **Owner hints from descriptors** [OBSERVED]: names in bank rows (`BRYS SEPULVEDA`, `MIRACLE SEPULVEDA`, `MIRACLE THOMAS`) and the PayPal handle (`BUNMIRA` on Miracle's rows) identify which person's Venmo or PayPal a row belongs to.
- **Aliases** map cleaned descriptors to one canonical **merchant**: `SEPHORA #182`, `SEPHORA.COM`, and `SEPHORA INSIDE KOHLS` all resolve to *Sephora*. Match types: `contains`, `word` (token boundary), `starts_with`, `regex`.
- **Unknown descriptors** automatically create an `unreviewed` merchant, and a **Merchants to review** page offers merge, rename, and alias editing.
- **Merchant groups** are user-curated, many-to-many collections that span merchants: "Makeup retailers" = Sephora + Ulta; "Delivery apps" = DoorDash + Instacart. Every report can group by merchant or by merchant group.
- A merchant can have a **default category** and a **default mode**, which handles about 90% of cases.

### 9.3 Rules

For conditional cases, such as amount-dependent categories, wrapper sources, and ambiguous merchants:

- **Fields:** `descriptor`, `merchant`, `merchant_group`, `account`, `source`, `amount_cents`, `direction`, `note`, `counterparty`.
- **Operators:** `contains`, `word`, `starts_with`, `regex`, `eq`, `between`, `in`.
- **Priority** then **specificity** (more conditions wins). If two enabled rules at the same priority match one transaction with *different* categories, that's reported as a **conflict**, not silently first-wins.
- **Backtest on save:** "this rule would have matched 14 past transactions; 13 were Eating Out, 1 was Groceries." This catches the `arco`/`ulta`-style false positives before they ship.
- Numeric comparisons are on cents, so `-150`, `-150.00`, and `-15000` are the same thing.

```json
{ "priority": 200, "mode": "auto",
  "match": { "all_of": [
      { "field": "descriptor", "op": "contains", "value": "venmo" },
      { "field": "counterparty", "op": "contains", "value": "brys" },
      { "field": "amount_cents", "op": "eq", "value": -15000 } ] },
  "action": { "type": "categorize", "category": "Laser Hair" },
  "origin": "legacy_guesser", "notes": "was: venmo && brys && price == '-150'" }
```

### 9.4 Modes: when to act and when to ask

| Mode | Behaviour |
|---|---|
| `auto` | Apply silently; listed in the **daily digest** so a bad rule is noticed |
| `suggest` | Apply as a pending suggestion; prompt with the answer pre-selected ("Eating Out? ✓") |
| `ask` | No default; prompt with ranked suggestions |

**Defaults are verbose (D5):** seeded rules and new merchant defaults start in `suggest`, never `auto`. Ambiguous merchants (Amazon, Target, Costco, PayPal wrappers) default to `ask`, or to a note-driven or item-driven rule (§10.5). You promote a rule to `auto` yourself once its `clean_confirmations` count satisfies you (§15.3).

### 9.5 Suggestions for unknown merchants

Ranked top 3 shown as one-tap buttons: (a) the merchant's past categories; (b) fuzzy-similar merchants (token / trigram similarity); (c) amount band; (d) the bank's own category column if the CSV has one (a weak hint). Plus search-all and "split".

### 9.6 Learning from your answers

After you categorize a transaction whose merchant has no rule, a sheet offers: **Always (auto)** / **Suggest next time** / **Just this once**, with the backtest shown. This replaces "edit `IFTTT_guess.gs`, add a `case`, redeploy".

### 9.7 Seeding from `IFTTT_guess.gs`

A one-time script converts each `case toCheck.includes("…")` group into rules, preserving file order as priority, and emits a report:

- **Short or risky tokens** (e.g. `arco`, `ulta`, `orca`, `m2m`, `76 -`) flagged for `word` matching.
- **Amount rules** converted to cents.
- **State Farm** is resolved by the data [OBSERVED]: the `15` and `19` are the end of the policy reference, and the named insured differs too. Rules become exact policy-reference matches: `…1283985715` and `…1780939870` (BRYS SEPULVEDA) → Car Insurance; `…1309172619` (MIRACLE THOMAS) → Miracle Life Insurance.
- **Drift the backtest will catch:** the 2026 mortgage payee is `ROCKET MORTGAGE LOAN …`, but the guesser only knows `unitedwholesale`; Spectrum Mobile, Duke Energy, and Cash App transfers were categorized as Family Support by hand; the `Pride` category appears in June 2026 with no rule. These show up as mismatches to review.
- **Categories that don't exist or are deprecated in `List`** (the structure reference notes Disney Plus and Lucidcharts are deprecated; Rent, Car Payment, Game Subs, HiDive have no `Budget` row) [OBSERVED].
- **`DELETE` outputs** (`chase card serv`, `payment thank you…`, `chase credit crd`) become `internal_transfer` rules, verified by pairing (§8.8). `greenlight app` is handled by the Greenlight engine instead (§11.2), since the ledger shows it was not always deleted.
- **Backtest against all history** (2020+): the mismatch rate doubles as validation of both the seeds and the migrated data.

### 9.8 Optional: LLM assistance (Phase 5)

You're open to a daily AI step if it makes the data side more robust (D19). The robust uses are all *suggestion-only and human-confirmed*:

- **Fallback parser:** when a deterministic parser marks an email or message `unrecognized`, an LLM proposes the fields (`parse_status = llm_proposed`) and you confirm in the Inbox. This protects against format changes in Chase, Greenlight, or receipt emails.
- **Item-category suggestions** for Amazon item names and emoji-only Venmo memos, never auto-applied below your existing "vague means flag" bar from the skills.
- **Daily verification job:** flags coverage gaps, duplicate-looking rows, and anomalies (a category suddenly 5× its trailing average).

It sends financial text to a third-party API, which is a privacy trade-off you should consciously accept or skip. The app works fully without it.

---


---

## 10. Notes pipeline (Amazon / Venmo / PayPal)

### 10.1 Two ways notes arrive

| Path | When | How |
|---|---|---|
| **Email receipts** (real-time) | as the order / payment happens | Receiver mailbox → parser → `external_notes` (+ items) (§8.5). [VERIFY: I haven't seen the emails; discovery will capture them, §19.2] |
| **Skill CSV** (bulk / backfill / fallback) | on demand | Upload the existing `Date,Amount,Note` CSV from the Chrome skills; the importer accepts it unchanged |

A small change to the skills would help matching and splitting: add optional columns `Source`, `Account`, `Counterparty`, `Ref` (order / payment ID), and `Items` (name, qty, price per item). They're optional, so current output keeps working.

### 10.2 What the three skills teach us (carried into the design)

| Learned in the skills | Design consequence |
|---|---|
| Amazon "points-paid phantom" rows exist alongside the real card charge | Parser / importer drops rows whose payment method is points, *before* matching |
| Amazon multi-shipment orders have one item list but separate charges | Subset matching (§10.5); otherwise `shared_note = true` and you're asked |
| Amazon notes are lowercase, comma-separated nouns (`bags,photo sleeves,cardstock`) | Auto-generated Amazon notes follow the same convention |
| Venmo memos are often emoji-only; a single generic emoji is *too vague* and must be flagged | Note-quality classifier: `sufficient` / `vague` / `none`. `vague` → `needs_note`, shown with the counterparty |
| Every flag must name the counterparty | The prompt and the Inbox always show counterparty and amount |
| Venmo: bank date is typically 1–4 days *after* the Venmo date | Per-source asymmetric date windows |
| Venmo "Standard Transfer Initiated" (cash-outs) are excluded *from notes* | Correction to v0.2: the bank-side `VENMO CASHOUT` row is **real income or reimbursement** and must be categorized (Miracle's → Gig Income; some of Brys's → Eating Out) [OBSERVED]. It is booked on the bank row, and the matcher proposes a split from the incoming Venmo receipts since the previous cash-out, because Venmo is often gig money but not always (D30) |
| Venmo / PayPal reversals: only the *net* needs to reconcile | Reversal rows net against the original; no 1:1 breakdown required |
| Households have **two** Venmo / PayPal logins on the bank feeds | Each person's Venmo / PayPal is its own account; the bank descriptor's name and the receipt's recipient pick it |
| PayPal foreign-currency charges must match on the **USD** amount | `external_notes.amount_cents` is always the USD charged |
| A recurring PayPal vendor (e.g. Instant Ink) is better solved by a *rule* than repeated notes | Recurrence detector suggests a rule |

### 10.3 Matching algorithm (replaces `matchExternalNotes`)

Inputs: transactions in `awaiting_note` / `needs_note` whose descriptor identifies a wrapper source, and the unmatched `external_notes` pool.

1. **Source- and owner-aware candidate filter.** A row whose descriptor says AMZN / AMAZON considers only Amazon notes; `PAYPAL *` only PayPal; `VENMO` only Venmo, and only that person's account where the descriptor names them (`VENMO … BRYS SEPULVEDA`, PayPal handle `BUNMIRA`). (Today all three sources compete for every row, which creates avoidable ambiguity.)
2. **Same sign, same amount** (±$0.005), plus a per-source date window. Proposed defaults: Amazon ±3 days; PayPal ±3 days; Venmo bank date in [Venmo date, +5 days] [PROPOSED, tune].
3. **Global assignment, not greedy passes.** Solve the one-to-one assignment over *all* pending rows and candidates at once, minimizing total date distance. This subsumes the "exact-date pass, then tolerance pass" hack and its stolen-candidate problem.
4. **Confidence** = margin between the best and second-best assignment. High → `auto_matched`. Low → `ambiguous`, with candidates ranked for a one-tap pick. Ambiguity is a *state*, not text in the note, so re-running never gets blocked by it.
5. **Late arrivals.** The matcher re-runs whenever a new `external_note` arrives or a transaction changes. Results never overwrite `user_provided` notes.
6. **Grace period.** With no candidate, the transaction waits (default 24 h Amazon / PayPal, 48 h Venmo) before a note prompt is sent. Receipt emails often arrive before the charge, so waiting avoids needless prompts. (Given your verbose preference, the grace period is configurable down to zero.)
7. **Prompt.** After the grace period: "What was this Amazon charge for?" (§15.4). The same prompt collects category or splits, per §1.4.

### 10.4 Note fields and states

`note` (final text), `note_source` (`amazon` | `venmo` | `paypal` | `manual`), `note_state` (`not_needed` | `auto_matched` | `awaiting_note` | `ambiguous` | `needs_note` | `user_provided`), plus `flagged` and `flag_reason` for "follow up later" (replacing `FLAG:` text). By default only the three wrapper sources require a note.

### 10.5 Item-level splits

Because one Amazon order often spans categories, a matched note with items becomes a **proposed split**.

1. **Item list.** Parsed from the receipt email (or the skill's `Items` column): name, qty, price.
2. **Allocate tax and shipping** proportionally across items, so splits sum to the charge. Rounding remainder goes to the largest item.
3. **Categorize each item.** Rules can match item names ("cat litter" → Pets); unmatched items prompt, one tap each, with the merchant's past item categories as suggestions. Item rules use the same engine as §9.3 with `item_name` as a field.
4. **Multi-shipment orders.** The order page doesn't say which items shipped in which charge (Amazon skill, pitfall 6). So when item totals exceed a charge, the matcher searches for an item subset whose total (plus proportional tax and shipping) equals the charge. One clean subset → proposed. Several → you pick, with the subsets shown. None → you tick the items.
5. **Default mode: `ask`** (D26). Per D5 you see every Amazon split proposal at first, pre-filled. Today you split by eye (e.g. 20/80 and ⅓–⅔ on the 05/30 and 06/28/2026 rows, with the same note on each row), so a percentage mode stays in the editor. Promotion to `auto` is per item rule, never global.
6. **Venmo and PayPal** split the same way when a note names several things; most are single-category.
7. **Points / gift-card portions** are excluded before allocation (the phantom-row rule above), so only the card-charged amount is split.

---

## 11. Greenlight

### 11.1 The messages, as they actually arrive [OBSERVED]

Verbatim samples from `IFTTTTransactions` column A (Android notifications captured by IFTTT):

| Shape | Example (trimmed) | Parsed fields | Default disposition |
|---|---|---|---|
| **Spend** | `Miracle spent $9.26 at TST* THE LUMBERYARD BA SEATTLE WA` | profile, amount, vendor (+ city / state) | per profile spend policy (§11.4); provisional until finalized |
| **Final amount posted** | `Miracle's final purchase amount of $25.78 at El Rinconsito Seattle has posted.` | profile, final amount, vendor | supersedes the earlier spend's amount (§11.4) |
| **Allowance sent** | `$50.00 allowance transferred to Miracle` · `$100.00 allowance transferred to Marion` | amount, profile (the name comes *after* "to") | `greenlight_allowance` (see §11.2) |
| **Allowance reminder** | `Miracle is scheduled to receive $50 allowance tomorrow morning. We'll send it unless you'd like to pause it.` | profile, amount | `ignored`; also feeds the expected-allowance forecast |
| **Return** | `↔️ Miracle moved $38.00 from Spend Anywhere to your Wallet. Tap to view details.` | profile, amount (note the emoji prefix) | `greenlight_return` |
| **Declined purchase** | `Marion's $33.79 purchase at WAL-MART #5393 GREENSBORO NC was declined due to insufficient funds in their GROCERY Spend Control. …` | profile, amount, vendor, spend control | **inform**: push to you, no ledger effect |
| **Savings reward** | `Miracle received a $0.07 Greenlight Savings Reward!` | amount | `ignored` (optional: credit the profile) |
| **Card shipped** | `Marion's Greenlight card is on the way! 📫 …` | profile | `ignored` |
| **Restriction notice** | `they can no longer use their debit card with payment apps` | body only (all IFTTT sends); **no profile in the text** | `ignored` / inform; never attributed to a profile |
| Request · ATM withdrawal | handlers exist in `IFTTT_Code.gs`; none in the sample I could read | | per policy (§11.5) |
| **Request approval** | you confirmed approving a request sends a message; **not yet captured** | | **deferred** (§11.5) |
| **Funding notice** | you confirmed a funding signal exists; **not yet captured** | | the bank row is authoritative (§11.2) |

What the samples settle:

- **The trailing `on <date> at <time>` is added by the IFTTT applet.** It appears on every message, including ones with no money in them [OBSERVED]. It's parsed as Pacific time, which is how today's sheet parses it; if a different capture tool ever delivers a message without the suffix, the arrival time is used.
- **Marion's messages already have the same shapes as Miracle's.** Parsing just needs the name taken from the text. Today the allowance handler is name-agnostic but hard-codes the category, so Marion's $100 allowances would be booked to **Miracle Spending**; her returns and withdrawals wouldn't parse at all (the regexes say "Miracle") [CONFIRMED-CODE].
- **IFTTT sends the body only.** The "debit card with payment apps" message therefore names no one and can't be attributed. Any message whose profile can't be parsed goes to *Unrecognized messages* and is never guessed (§11.8).
- **Vendors carry city and state** (`TST*ANAS CAFE Seattle WA`), unlike Chase's alert text, so descriptor cleaning strips a trailing `CITY ST` (§9.2).
- **Greenlight has spend controls and a "Spend Anywhere" bucket** (the declined and return messages both mention them). Nothing depends on this today.

### 11.2 Which event charges the bucket? (decided: option A, D29)

Four money events exist. The model must charge each bucket **once**:

```
bank ──funding──▶ shared wallet ──allowance──▶ profile ──spend──▶ vendor
                       ▲                          │
                       └──────────return──────────┘
```

**What the ledger does today** (rows I could read; not exhaustive):

- Bank funding rows `GREENLIGHT APP yymmdd GREENLIGHT BRYS SEPULVEDA` are **categorized Miracle Spending**: variable top-ups in 2023 (e.g. −$407.49, −$688.62), −$55 in Apr 2024, and from Apr–Jun 2026 mostly −$50 about weekly, plus a recurring −$6.62 on the 25th that looks like a monthly plan fee [INFERRED].
- `GREENLIGHT ALLOWANCE` rows (−$150 weekly, later −$100) are in the ledger for roughly Oct 2023–Dec 2024, alongside funding rows in the same weeks (e.g. Apr 2024). In the May–June 2026 rows I saw funding rows and **no** allowance rows.
- The guesser maps `greenlight app` to `DELETE`, so the funding rows in the ledger were categorized by hand.

So in some periods the bucket was charged by funding, in some by allowance, and in some by both.

| | **A: allowance charges (v0.2 default)** | **B: funding charges (cash basis)** |
|---|---|---|
| Funding (bank → wallet) | `internal_transfer`, no charge | charges a category |
| Allowance (wallet → profile) | charges the profile's category | informational |
| Two profiles on one wallet | **attributes correctly** (the message names the profile) | cannot tell Miracle's money from Marion's; you'd split each funding row by hand |
| Depends on notifications | yes (mitigated by expected-allowance booking) | no, bank rows only |
| Matches your recent habit | no (you charge funding today) | yes |

**Decision: A**, taking effect at the backlog. The unrecorded period starts in July 2026 and Marion's card shipped on Aug 3, so the second profile arrives exactly where the new rules begin. Earlier history is migrated unchanged, so parity holds. Under A, funding is still tracked (wallet balance = funding − allowances + returns), it just doesn't charge a category. Option B remains available as a per-wallet setting but is not used.

The monthly −$6.62 `GREENLIGHT APP` rows look like a plan fee, not funding. They get their own rule, defaulting to `Fees and Taxes` in `suggest` mode, so the first occurrence asks you to confirm (§21.1).

### 11.3 Profiles → categories (D7)

| Profile | Category | Spend policy | Request policy | Withdraw policy |
|---|---|---|---|---|
| **Miracle** | Miracle Spending | `reclassify` | `as_allowance` | `ask` |
| **Marion** | Family Support | `ignore` | `ask_category` | `ask` |

The profile name is parsed from each message and matched against `name_pattern`; all policies are editable (D8). One shared parent wallet [CONFIRMED-USER].

### 11.4 Spend policies (D8)

**`ignore`** (Marion): the spend becomes `ignored(reason = greenlight_spend)`; the raw event is retained and nothing prompts. (Her spends are mostly Walmart, McDonald's, and similar purchases in North Carolina [OBSERVED]; the money was already charged to Family Support at allowance time.)

**`reclassify`** (Miracle): the vendor goes through the normal merchant and rule engine (§9). If it resolves to a category other than Miracle Spending, the app creates a **`greenlight_reclass`** transaction whose splits sum to zero:

```
Miracle spends $21.83 at El Rinconsito Seattle (rule: Eating Out)
   Eating Out        −21.83
   Miracle Spending  +21.83        ← she "gets that money back"
```

**Spends are provisional until finalized.** On Sep 28 Miracle spent $21.83 at El Rinconsito; on Sep 30 a "final purchase amount of $25.78 … has posted" notice arrived [OBSERVED]. The notice is matched to the earlier spend (profile, vendor, proximity), the reclass is re-derived at $25.78, and the change is logged. A spend with no finalization notice stays at its original amount.

If the vendor resolves to nothing, it prompts like any transaction, with **"Miracle Spending (leave it)"** as a one-tap answer.

### 11.5 Request policies (D10) and the deferred approval message

A request must never double-charge, so **a request message never posts a charge by itself**. It creates a pending `greenlight_request`; money is charged only when it actually moves.

| Policy | Behaviour |
|---|---|
| **`as_allowance`** (Miracle) | When the approval's money movement is recorded, it books as an **extra allowance** (debits Miracle Spending), linked to the request. Her spend then reclassifies normally. Example: she requests $125 for a manicure → extra allowance (Miracle Spending −125) → she pays the nail salon → rule Manicure → reclass (Manicure −125, Miracle Spending +125). Net: Manicure −125, which is what you book by hand today (e.g. the Nov 2023 request rows) |
| **`ask_category`** (Marion) | A prompt asks which category pays; that category is debited, as you do now |

**Deferred (D23):** approving a request sends a message, but I haven't seen one. Until a sample is captured, it lands in *Unrecognized messages* and the pending request asks you "approved or declined?". The first real approval message gets a parser. Requests go stale if unanswered.

### 11.6 Event dispositions (defaults) [PROPOSED]

| Event | Disposition |
|---|---|
| Spend | profile's spend policy (§11.4) |
| Final amount posted | updates the matching spend |
| Allowance | `greenlight_allowance`, auto, profile's category (under option A) |
| Return | `greenlight_return`, auto, profile's category |
| Request | pending request (§11.5) |
| Withdraw | profile's withdraw policy; default prompt |
| Bank row `GREENLIGHT APP yymmdd …` | `internal_transfer` bank → wallet under A; the embedded `yymmdd` is the event date. Fee-like amounts get the fee rule |
| Declined purchase | **inform**: push to you ("Marion's $33.79 at Walmart was declined: GROCERY control"), no ledger effect |
| Reminders, savings reward, card shipped, restriction notices | `ignored` by a known-noise list; anything unknown → *Unrecognized messages* |

### 11.7 Parsers and fixtures

One parser per message shape, taking the **profile from the text**. The nine observed shapes in §11.1 become the first fixtures, using your real rows (redacted); the deferred ones are added when they occur. Timestamps come from the IFTTT suffix, parsed as Pacific, or from arrival time if it's absent.

The allowance **reminder** ("scheduled to receive $50 … tomorrow morning") can seed an **expected allowance** per profile, so a missed "transferred" notification shows up as a gap instead of a silent hole (on by default, §11.8).

### 11.8 Accuracy safeguards (D29)

You said the priority is that Marion's and Miracle's money never lands in the wrong category. These safeguards make that checkable rather than hoped for:

1. **The profile always comes from the message text.** A message whose profile can't be parsed (such as the subject-less "debit card with payment apps" notice) goes to *Unrecognized messages*. It is **never guessed**.
2. **One charging event per wallet.** Under option A, allowances charge and funding never does. The engine refuses to post a charge for both events on the same wallet, and a test asserts it.
3. **An attribution property test.** For every Greenlight message about profile X, no resulting split touches profile Y's category. Miracle's events only ever reach Miracle Spending and the categories her reclassifications resolve to; Marion's reach only Family Support and what she explicitly assigns.
4. **Expected-allowance forecast is on by default.** The reminder messages ("scheduled to receive $50 … tomorrow morning") create an expected allowance. If the matching "transferred" message doesn't arrive, it shows as a gap in the Inbox and the close checklist instead of a silent hole.
5. **Wallet reconciliation.** The wallet's computed balance (`funding − allowances + returns`) is shown, and the close wizard asks you to confirm it against the real wallet balance when you have it. Drift points at a missed message.
6. **Provisional spends** are re-derived when the final amount posts (§11.4), so reclass entries track the real amounts.

---

## 12. Budgets

### 12.1 Categories and groups

CRUD with stable IDs, so **renaming never breaks history** (the sheet keys everything by name). Fields: name, group, kind, discretionary, cushion, start month, status.

- **Add category:** name, group, start month (default current), initial monthly amount (creates the first version), discretionary or not, optional starter rule. Validation requires a start month, preventing the `historicalBudget` throw on a missing Start Date.
- **Retire category:** one action sets status `retired`, appends a `0` version effective the chosen month, hides it from pickers, and *preserves* all transactions. If the balance is non-zero, it offers a one-step **transfer of the remaining balance** to another envelope. Migration also lists categories that look retired but are unflagged (Rent, Lovesac Couch, Car Payment, Game Subs, Boiling Point [OBSERVED]).

### 12.2 Changing one category's amount (the quick path)

Change amount → pick effective month (default **this month**) → optional reason → Save. The system appends a version; the old value stays visible in that category's **history timeline** (when, from → to, by whom, which plan, why), with a step chart of the target over time and the balance over time. There's no separate History row to write. This is the "new value automatically records the last value" behaviour you described.

### 12.3 Budget page

Same information as `Budget`: group, name, target, balance (`Current`), Spent / Gained for two selectable periods (defaults: this month and last month), and a pace bar. Header: the **live plan's earnings**, allocated, and unallocated. Favorites float to the top on mobile. A toggle shows the **budget percentage pie** (§14.2).

### 12.4 Plans (replaces `New` and the manual copy)

A **plan** is a complete set of monthly targets *plus the earnings scenario it was built for*.

- **CRUD:** create (from scratch, from live, or from another plan), rename, clone, delete drafts. As many drafts as you like.
- **Assign earnings:** pick an **earnings scenario** (§12.5), current or new. The plan header shows `income − allocated = unallocated` live. Over-allocation warns but doesn't block.
- **Editing aids:** bulk adjust (±%, round, set to trailing 3 / 6 / 12-month average), side-by-side compare of two plans, per-row notes.
- **Make live:** a button that opens a confirm dialog showing:
  - the **diff**: only categories that change, old → new, the delta, and the **N history entries that will be created**
  - the **income change** (old scenario → new scenario) and the resulting allocated and unallocated
  - the **effective month** (default current; next month available)
  - for a past month, an unmissable **"restate history"** warning with the computed balance change per category
  - a final confirm (type-to-confirm for retroactive changes)
- **Atomicity:** one transaction appends a version per changed category (each linked to the plan), **snapshots the scenario's net income onto the plan** (`income_snapshot_cents`), marks the plan `live`, and archives the previous live plan as an immutable snapshot. Editing a scenario later therefore never silently changes a live plan.
- **Revert:** reactivating the archived snapshot is just another go-live with its own diff and audit entry.
- **Staleness guard:** if live changed after the draft was created, the dialog says so and re-diffs against *current* live.

No two-person approval step (D15).

### 12.5 Earnings: scenarios (D14, D21)

You want to enter gross salary at different levels, get net monthly back after aggregate taxes, assign that to a plan (current or new), and when your income changes, make a new plan and set it live. That is exactly what the blocks on `Projection` do, so the model follows them.

**How the `Projection` blocks work** [OBSERVED; I checked the arithmetic against the sheet's own numbers]:

| Row | Meaning |
|---|---|
| Yearly Salary | full-time annual gross, per person (Brys, Miracle) |
| Work Time | fraction of full time (100%, 92%) |
| Taxes | one aggregate effective rate per person (31.5%, 32%, 33%, 34%, 35%; can differ between people in a block) |
| Net | `salary × work time × (1 − taxes)` |
| Monthly Gross / Monthly Net | `salary × work time ÷ 12`, `Net ÷ 12` |
| Bi-Weekly | `Net ÷ 26` |
| Household | sum across people |

Worked example, the live block: $220,000 × 100% × (1 − 32%) = $149,600 → ÷ 12 = **$12,466.67**, which is what `Budget!B2` reads. The $30,720 × 92% × (1 − 31.5%) = $19,359.74 line from an older block checks out the same way.

**Model** [PROPOSED]

- An **earning scenario** is a named set of **lines**: `person, label, annual salary, work time %, tax rate %, recurring`. Each line yields gross, net, monthly net, and bi-weekly; the scenario's **monthly net** is the sum of recurring lines.
- A **one-time line** (the "Bonus? $25,080" next to the $240k block) is shown but excluded from monthly net, as in the sheet.
- **Miracle's gig income is not part of the plan.** Her recent blocks are $0 because her income is gigs, which are tracked as actuals under **Gig Income** and used as the overage pool (§13). Her salary line stays available, since the sheet used it for years.
- **UX:** type the gross, work time, and effective rate and see monthly net and bi-weekly update live. Clone, compare two scenarios side by side. Names are generated ("Brys $220k @ 32%") and editable.
- **Assignment:** a plan references one scenario; making the plan live **snapshots** the scenario's monthly net onto it (§12.4), so editing a scenario later never silently changes a live plan.
- **Seeding:** the roughly dozen blocks on `Projection` import as scenarios. The $220k @ 32% block becomes the live scenario because it equals `Budget!B2` ($12,466.67); the others are archived for reference. The Savings 1–7 projections and the trip-cost table on that sheet stay in Sheets (a non-goal).
- Salary and Hourly Income keep their `N/A` category balances (§6.3); this is planning income, not tracking it.

**Planned vs actual (small addition).** The Dashboard can show the live scenario's monthly net next to recent **Salary** deposits. In the rows I could read, Sequoia payroll deposits on 05/29, 06/12, and 06/26/2026 were about $6,526, $6,463, and $6,460, so roughly $14,000/month if you get 26 paychecks, against $12,467 planned [OBSERVED from three rows; withholding may differ from the flat rate, and two months a year have three paychecks]. If that holds, the plan is conservative by about $1,500/month. The app would surface this automatically instead of you noticing by chance.

### 12.6 Concurrency and audit

Optimistic locking (`version`) on categories, plans, scenarios, and transactions, so two people editing never silently overwrite each other. Every mutation writes `audit_log` with before / after.

---

## 13. Envelope operations and month close

### 13.1 Rebalance (replaces the reingest reconcile pass)

**Eligibility, per category** (D11):

| Category | Can donate |
|---|---|
| Discretionary | its balance above its cushion (default cushion 0) |
| Non-discretionary, cushion set | only the balance **above its cushion**, and only once the balance exceeds the cushion |
| Non-discretionary, no cushion | nothing (immune) |

Cushion semantics: *the surplus that must remain before any money can move*, so donatable = `max(0, balance − cushion)`. You confirmed this reading of "minimum overage required" (D11).

**Funding order** for each overspent category (balance < 0):

1. **Gig Income pool** first (D12). Overages are covered in **priority order** (D24): each category has an `overage_priority` rank (1 = covered first); unranked categories go last, largest overage first.
2. Then **discretionary donors**, proportionally to their donatable surplus.
3. Then **non-discretionary donors above cushion**, proportionally.
4. Any remaining shortfall is shown explicitly rather than hidden.

**Auto-propose, then review (D24).** You'd rather assign manually but are fine reviewing an automatic proposal, so both work: the wizard opens with the priority-order proposal, and you can edit any amount, clear it, or build the whole thing by hand. You see the **resulting balance of every touched category** before committing. Commit creates one `pool_payment` transfer (from the pool) and one `reconcile` transfer (from donors), each with legs summing to zero.

### 13.2 Placing what's left (replaces the Gig Income distribution)

After overages are paid, any **remaining pool balance** is placed **by hand**: pick categories and amounts, with a live "remaining" counter. No templates (D12). Commit creates one `placement` transfer. The close checklist wants the pool at 0 or explicitly acknowledged.

### 13.3 Manual transfer

Any envelope → any envelope, with a memo. Same transfer entity, so it's excluded from spend reports by construction.

**Adjustment (zero-out).** A single-leg write-off with a reason, for what the sheet does with rows like `Zero Out Manicure −$500` (Apr 2024, no matching credit) [OBSERVED; confirmed, D31]. It removes an envelope's balance from the budget altogether. Adjustments are allowed to be unbalanced (§7.8), so reports list their total separately, which keeps "total envelope funds vs. income" explainable.

### 13.4 Close wizard and checklist (replaces Phase 2's last pass)

A guided sequence, each step linking to the offending rows:

| Step | Pass condition |
|---|---|
| 1. Coverage | every account has data through the close date (± tolerance) |
| 2. Uncategorized | 0 transactions in `needs_category`. This is your `NEEDS CATEGORY is 0` check: that sheet category becomes the needs-category state (§18.2) |
| 3. Provisionals | 0 stale provisionals |
| 4. Notes | 0 `needs_note` / `ambiguous` among note-required transactions |
| 5. Flags | 0 unresolved `flagged` |
| 6. Duplicates | 0 suspected duplicates (same account / date / amount / descriptor) unreviewed |
| 7. Greenlight | 0 pending requests; wallet balance matches the number you typed, if you gave one |
| 8. Unrecognized | 0 unrecognized messages |
| 9. Overages | overspent categories paid from the pool, then donors (§13.1) |
| 10. Pool | pool categories (Gig Income) placed by hand to 0 (§13.2) |
| 11. Review | a final scan of the month's biggest and newest transactions |

**Close period** (optional) snapshots balances and soft-locks edits through that date; editing a closed period requires a reopen with an audit entry. Skippable if you'd rather not have a lock.

---

## 14. Reporting and visualization

### 14.1 Metric definitions

- **Spent** = net outflow = −Σ split amounts in kinds `spending`, `greenlight_allowance`, `greenlight_return`, `greenlight_reclass`. **Refunds and Greenlight offsets reduce Spent** (D13); they are not "Gained".
- **Gained** appears only for income categories: positive receipts.
- **Reimbursements are common, not rare** [OBSERVED]: friends' Zelle and Venmo payments back (e.g. into Gifts Budget or Eating Out), Airbnb and Amazon refunds. Netting them into Spent is clearly the right default.
- **Never included:** transfers, accruals, `internal_transfer`, `ignored`.
- **Sheet-compatible mode** (used only by the parity test, §18.3): Spent = negative charges, Gained = positive charges, excluding names matching `[rR]eingest`.
- **Dimensions:** category, group, merchant, merchant group, account, person, month / week / day, source.
- **Ranges:** this / last month, last 30 / 90 days, QTD, YTD, trailing N months, custom.

### 14.2 Charts

| Chart | Question it answers |
|---|---|
| **Budget percentage pie** (D18) | How is the monthly budget divided? Slices are share of total allocated (and optionally of income). Toggle: allocated share ↔ spent share. Shows **groups**, click through to categories, since a 50-slice pie is unreadable [confirmed, D25] |
| Budget vs. actual by category (bullet bars) | Where am I this month? |
| Spend by category over time (stacked bars, monthly) | How are mix and total moving? |
| Category trend with trailing average and budget line | Is this budget realistic? (one tap → create a plan item) |
| Envelope balance over time (line, per category) | Which envelopes drift negative and when? |
| Group roll-up (treemap / sunburst) | What are the big blocks? |
| Month-over-month heatmap (categories × months) | Seasonality and anomalies |
| Top merchants / merchant groups (ranked bars) | Where does money actually go? |
| Income vs. spend vs. allocated | Is the plan funded? |
| Budget history step chart (per category) | How did this target change? |
| Pace gauge for favorites | Am I on track given days left? |
| Year pivot (category × year) | Replaces the `Year` sheet |

Charts use **Apache ECharts** with modular imports so only the used chart types ship [VERIFY bundle size]. Every chart drills down to the underlying transactions. Aggregates are plain SQL; with tens of thousands of rows there's no need for pre-aggregation.

### 14.3 Explore (replaces `Insights`)

Free-text and merchant search over description, note, item name, and merchant group, with a date range, returning **total, monthly average, count, and a sparkline**. "Sephora" resolves via the merchant, so it covers every store. Save searches as favorites.

---

## 15. Phone app (Android PWA)

### 15.1 Scope: reduced and fast

Installed to the home screen; opens straight to **Home**:

```
┌─────────────────────────────────┐
│ Needs you (3)                   │
│  Sephora          $42.10        │
│   [Makeup] [Gifts] [Other ▸]    │
│  Amazon           $23.99        │
│   2 items · assign categories ▸ │
│ Favorites                       │
│  Eating Out  $212 left  ▓▓▓▓░   │
│  Groceries   $48 over   ▓▓▓▓▓!  │
│ Recent                          │
│  Chipotle  -$14.20  Eating Out  │
│  …                              │
│ [＋ Add]   [Search]             │
└─────────────────────────────────┘
```

| Section | Content |
|---|---|
| **Needs you** | The Inbox: `needs_category`, `needs_note`, `ambiguous`, stale provisionals, flagged items, pending Greenlight requests. Answerable inline |
| **Favorites** | Your chosen categories: balance, spent this month, pace bar; tap for that category's recent transactions |
| **Recent** | Last ~20 transactions with category and a pending marker for provisionals; tap to edit category, note, or split |
| **Quick add** | Manual / cash transaction in three taps |
| **Search** | Merchant, note, or category |

Anything heavier (plans, rules, reports, close) is a link to the full site.

### 15.2 Platform notes [VERIFY]

- Android Chrome: install prompt, web push, and notification action buttons, so common answers (e.g. "Eating Out ✓") can be one tap on the notification itself.
- Every prompt also has a deep link to a **quick-answer sheet** for anything the buttons can't carry (search, split, notes).
- A service worker caches the last Home snapshot, so the app opens instantly and works read-only offline; answers made offline queue and sync.
- Lock-screen privacy (hiding merchant and amount) is a setting, off by default since you want verbose.
- Android Doze and battery optimization can delay pushes; exempt the app from battery optimization at install.

### 15.3 Notification policy (verbose first, D5)

| Rule | Default [PROPOSED] |
|---|---|
| Who | The **purchaser**: card owner, receipt email's owner, or the Greenlight profile's parent. Chase is one shared card and Wells Fargo rows don't name a purchaser either, so unknown purchaser → **both** of you; the first answer cancels the other's prompt |
| Immediate | **Every** transaction needing a decision, real-time when a feed exists (Chase alerts, Greenlight) |
| Daily catch-all | One digest each morning: everything from the daily lane (Wells Fargo notice, CSV-derived items), anything unanswered, and a count of what was auto-categorized |
| Quiet hours | Configurable, **off** by default; the midnight Wells Fargo notice is deferred to the morning digest rather than pushed |
| Cap | None to start. Add a cap or batching once you want to taper |
| Escalation | Unanswered for N days → also nudge the other person (optional) |
| `auto` decisions | Listed in the daily digest (so a bad rule is noticed); never an individual push |
| Silence alert | A source going quiet always pushes (§8.7) |

**Tapering.** Instead of a global knob, you taper rule by rule: a rule or merchant shows its `clean_confirmations` (times you accepted its suggestion unchanged); at a threshold you choose, the app offers "promote to auto?" with the backtest. Nothing graduates without your click.

### 15.4 Prompt types

| Prompt | Shows | Answers |
|---|---|---|
| **Categorize** | merchant, amount, date, account, top-3 suggestions | one tap; More (search); Split; "Not a budget item"; Later |
| **Note** (Amazon / Venmo / PayPal) | counterparty, amount, candidates if any | pick a candidate or type; also sets category or splits if needed (§10.5) |
| **Confirm match** | the transaction and ranked candidate notes | pick one |
| **Assign items** | an Amazon order's items with suggested categories | confirm or change each; tick items for multi-shipment charges |
| **Make a rule?** (follow-up) | backtest summary | Always / Suggest / Once (§9.6) |
| **Greenlight request** | profile, amount | Approved / Declined; Marion's also asks which category pays |
| **Greenlight unknown** | the raw message | Ignore / Credit profile / Debit profile / Ask later |
| **Greenlight declined** (informational) | profile, amount, vendor, spend control | dismiss; no ledger effect |
## 16. Web app

| Page | Purpose |
|---|---|
| **Dashboard** | KPIs, unallocated, close-readiness, trend glance |
| **Transactions** | Filter by anything, search, bulk edit (category, note, ignore), split, history per transaction |
| **Inbox** | Same as phone's Needs-you, with bulk actions |
| **Budget** | §12.3 |
| **Plans** | §12.4: drafts, assign an earnings scenario, diff-and-confirm go-live |
| **Earnings** | §12.5: units and scenarios |
| **Category detail** | Transactions, budget history, balance chart, rules pointing here |
| **Merchants** | Review queue, merge/rename, aliases, groups |
| **Rules** | List with hit counts, last hit, conflicts, backtest, enable/disable |
| **Imports** | Upload CSV (with preview), import history, per-account coverage |
| **Transfers** | Rebalance (pool first, then eligible donors), hand placement of the pool, manual, history |
| **Close** | §13.4 |
| **Reports / Explore** | §14 |
| **Greenlight** | Profiles and policies, pending requests, wallet balance and funding, unrecognized messages |
| **Settings** | Accounts, import profiles, ingest tokens, notification prefs, favorites, users |
| **Ingest health** | Per-source status, unrecognized / failed events, reparse |
| **Audit log** | Who changed what, when; with undo where safe |

---


---

## 17. Architecture, hosting, security

### 17.1 Components

```
 Android PWA ─┐                                    ┌─ Receiver mailbox (Gmail + Apps Script) ─▶ /ingest/email
 Web UI  ─────┼──▶  App server (API + static UI) ◀─┤─ Phone automation (IFTTT webhook / MacroDroid) ─▶ /ingest/device
              │       │   ├─ ingestion / parsers   └─ CSV upload (and optional SimpleFIN pull)
              │       │   ├─ matcher / rules engine / Greenlight policies
              │       │   ├─ scheduler (stale checks, digest, silence alerts)
              │       │   └─ web-push sender
              │       ▼
              │    SQLite file ──▶ nightly backup to Cloud Storage
```

### 17.2 Stack recommendation [PROPOSED, D3]

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript**, end to end | Shared types and shared rule / matcher logic between server and UI make "backtest while editing a rule" cheap |
| UI components | **Lit** (native custom elements) | ~5 KB-class runtime [VERIFY], no virtual DOM, no JSX, reactive properties, scoped styles. It is a thin layer over web components, not a view-model framework |
| App structure | Plain modules: a tiny client router, one `fetch` API client, a small event-based store | No MVVM layer. Components receive data via properties and emit events; pages own their data loading |
| Build | **Vite** | Fast, minimal config, handles the PWA service worker (e.g. via a Vite PWA plugin [VERIFY]) |
| Charts | **Apache ECharts**, modular imports | Covers the pie, treemap, heatmap, and stacked bars from one library |
| Server | Node with **Fastify** (or Hono) | Small, typed, fast enough for two users |
| Database | **SQLite** via `better-sqlite3`, WAL mode, with a thin typed query layer (Kysely) | One file on the VM disk; the layer lets a move to Postgres stay cheap if you ever want it |
| Push | `web-push` with VAPID keys [VERIFY] | Works with Chrome on Android; no vendor account beyond the browser's push service |
| Tests | Vitest | Same toolchain as Vite |

I'd avoid component libraries that assume React. For UI pieces Lit doesn't ship (dialogs, date pickers), native `<dialog>` and `<input type="date">` cover most of it.

### 17.3 Hosting on GCP (Option A, D4) [VERIFY all pricing and quotas]

**One `e2-micro` VM + SQLite + nightly backup to Cloud Storage.**

| Item | Cost / note |
|---|---|
| Compute | Within the always-free allowance for one e2-micro VM and a standard persistent disk in `us-west1`, `us-central1`, or `us-east1` (use `us-west1`). The free VM is region-restricted; the wrong region is billed |
| Cloud DNS (D17) | No free tier; **$0.20 per zone per month plus $0.40 per million queries** [verified on Google's pricing page]. For two users, effectively ~$0.20–0.25/month |
| Domain | ~$12/yr |
| External IPv4 | Possibly a small monthly charge for the VM's external address [VERIFY] |
| Backups | A nightly dump to Cloud Storage; at this data size it's pennies (the free storage allowance is region-specific) |
| TLS | Caddy with Let's Encrypt (automatic) |

The data is tiny (thousands of rows a year), two users, single-writer; SQLite in WAL mode is more than enough, and 1 GB of RAM comfortably runs Node plus SQLite. Run the app under `systemd`; deploy by pulling a build artifact; keep the last N backups. **Restore drill:** restore the latest backup onto a scratch VM before cut-over and once a quarter.

### 17.4 Auth and security (KISS, D4)

- **Sign-in:** Google OIDC restricted to an allowlist of two emails. No passwords stored.
- **Sessions:** httpOnly, SameSite cookies; CSRF protection on mutations.
- **Ingestion endpoints:** one HMAC-signed token per source / device (`ingest_tokens`), with replay protection (timestamp + nonce) and rate limiting.
- **Secrets:** a plain environment file on the VM, mode `0600`, readable only by the service user. **No secret manager** (D4).
- **Encryption:** Google Cloud encrypts persistent disks and storage buckets at rest by default, at no extra charge [VERIFY], so there's no separate encryption step to build or run. No backup-encryption layer.
- **No bank credentials** are ever stored by the app.
- **Push payloads** carry minimal data; sensitive text is fetched after tap (or shown on the lock screen if you choose, §15.2).
- **Audit log** for every mutation. **Dependency updates** on a schedule.
- **Receiver mailbox scope:** the Apps Script runs only in the receiver account, which holds only forwarded alerts and receipts, so it never has access to either main mailbox.

### 17.5 Testing strategy

| Area | Approach |
|---|---|
| Parsers | Fixtures from real, redacted messages (Chase, each Greenlight shape, receipts); a format change fails a test |
| Balance engine | Property tests on the invariants in §7.8 plus the **parity harness** (§18.3) |
| Greenlight | Table-driven cases: spend with / without a category rule, request then funded, request never double-charging, Marion ignore vs. Miracle reclass. **Attribution property test:** for every message about profile X, no split touches profile Y's category; funding never charges under option A (§11.8) |
| Paired transfers | Card-payment legs in either import order, Wells Fargo ↔ Wells Fargo moves, an unpaired leg flagged, the savings transfer staying categorized (§8.8) |
| Shapes and replay | Capture raw events with no parser, add a parser, replay, and assert the resulting transactions are identical on a second replay |
| Matcher / assignment | Cases from the skills' pitfalls: points phantom, multi-shipment subset, same-amount same-day |
| Rules | Backtest as a test: the seeded rules against migrated history |
| Time | DST edges (Nov 1, 2026; Mar 2027), Eastern alert vs. Pacific date at midnight |
| Idempotency | Re-import and re-run everything; assert no user decision changes |
## 18. Migration and parity

### 18.1 Inputs

Export from the sheets as CSV: `Transactions`, `List`, `History`, `Budget`. Capture `Internal!A:B` and `Internal!H:J` (the sheet's own computed values) **on the same day**, to use as the parity oracle. The data is currently ~3 months behind [CONFIRMED-USER]; that doesn't matter for parity as long as both sides use the same as-of date.

### 18.2 Mapping

- **Categories:** from `List` (name, parent → group, `Start Date` → `start_month`, `Deprecated` → status). Report and resolve categories used in `Transactions` but missing from `List`.
- **Budget versions** per category, using the sheet's own algorithm:
  - take that category's `History` rows, sorted by stop month ascending (skipping rows with blank category or blank stop month)
  - **replicate the sheet's silent drop**: a row whose stop month ≤ the previous boundary contributes nothing (`monthDiff` ≤ 0). Drop it **and report it**, because it's a latent data error
  - emit versions: `(start → old₁)`, `(stop₁ → old₂)`, …, `(stopₙ → current Budget amount)`
  - a category present in `History` but absent from `Budget` is retired: its last version is `(stopₙ → 0)`
- **Transactions → transactions + one split each.** Rows sharing a date, name, and `Split Total` are **linked** as a `legacy_split_group` but **not merged**, because the group doesn't always add up: e.g. 30.50 + 30.50 + 122.01 = 183.01 against a Split Total of 183.02 [OBSERVED]. Every row keeps its exact amount, so lifetime sums stay identical. Groups also include 3-way splits, ⅓–⅔ splits, and positive reimbursement rows. Deposit "distributions" (a 2023 deposit spread across ~17 categories, Split Total 12,299.93) migrate as ordinary positive rows.
- **Reallocation rows** are not all named `Reingest`. Observed [OBSERVED]: `Reingest X`, `X Reingest`, the typo `Reignest Patreon`, and `Zero Out Manicure`. The sheet's exclusion regex (`[rR]eingest`) misses the last two, so they currently leak into its Spent/Gained; **sheet-compatible mode reproduces that leak** so P4 still matches, while the app's own reports exclude them. Detection uses name patterns (`reingest`, `reignest`, `zero out`, `ingest`) plus same-date clusters that sum to about zero, and produces a review list. They import as single-leg `legacy` transfer legs or `adjustment`s (kind inferred from the name). They carry no pairing key, so pairing is attempted by date + name + zero-sum only as a convenience; unpaired legs stay single-leg. **Balances are unaffected either way.**
- **`[Category] Ingest` 2020-era rows:** imported as `legacy` adjustments for you to inspect (likely opening balances [INFERRED]).
- **History depth (D16):** every transaction since 2020 is imported, which lifetime balances require. Per-category *snapshot* transactions (a single row holding the total up to a date) are a fallback only for rows that fail to import cleanly, and each is reported.
- **Greenlight history:** every historical row migrates **exactly as categorized**: `GREENLIGHT ALLOWANCE` and `GREENLIGHT RETURN` rows, and the `GREENLIGHT APP` funding rows that the sheet charged to Miracle Spending, are ordinary `spending` / `income` transactions. Nothing is reinterpreted retroactively, so lifetime balances equal the sheet's. The new Greenlight model (§11.2) takes effect from the backlog onward, and the cut-over date is recorded.
- **`NEEDS CATEGORY`** is a real category on the sheet (Goods, $0 budget). Rows in it, and blank-category rows, import as **`needs_category`** (null-category splits). The `Year` sheet shows −$546.00 (2024) and −$984.22 (2025) still parked there; some look resolvable (e.g. a $300 `ZELLE FROM PREMIER VOCAL ENTERTAINMENT` row from 05/09/2025, which the guesser maps to Gig Income). **You chose to resolve them during migration (D32).** The order matters: parity (P1–P7) is proven first on the unresolved data, with `NEEDS CATEGORY` treated as its own pseudo-category so totals match the sheet. Then a **resolution worksheet** lists every parked row with a backtest-suggested category, which you accept or edit in bulk, and the app reports the before / after balance of every category it moves money between. That second step is a separate, audited edit, not part of the import.
- **Blank-category rows:** imported as `needs_category`. The sheet counted them in no envelope (`Internal!A4` showed −$227.48 in the July snapshot [OBSERVED]); the app will list them for you to resolve.
- **`Notes`** carried over; text flags (`???`, `FLAG:`, `?? AMBIGUOUS`) become `flagged` with the text preserved.
- **Merchants:** bootstrap by cleaning all historical descriptors and clustering; the review page proposes merges and brand groups, so the history gets merchant analytics too.

### 18.3 Parity tests (cut-over gate)

| # | Test | Oracle |
|---|---|---|
| P1 | Per category, `Months` and `Total` equal | `Internal!H:J` |
| P2 | Per category lifetime transaction sum (incl. legacy transfers) equal | `Internal!A:B` |
| P3 | Per category `Current` equals | `Budget!D` |
| P4 | This/last-month Spent and Gained equal in **sheet-compatible mode** (§14.1: sign-split semantics, `Reingest` excluded) | `Internal!M:W` / `Budget!E:H` |
| P5 | Total transaction count and total amount equal | `Transactions` |
| P6 | Allocated total equals | `Budget!C2` |
| P7 | Every difference is explained in a report; **zero unexplained** | n/a |

### 18.4 Data cleanup surfaced by migration

History rows dropped for ordering; categories missing a Start Date; categories that look retired but aren't flagged; duplicate category rows in `Budget` (the sheet double-counts them); stray text in `Budget!B` below the table (treated as a category by the sheet); transactions with categories not in `List`.

### 18.5 Cut-over plan

1. Freeze the sheets (stop editing).
2. Run migration, then parity; fix until P7 is clean.
3. Use the app's CSV importer for the **three-month backlog** (via backlog mode, §8.3): dogfood, with the sheet's math as the oracle.
4. Run one close in the app. Keep the sheet read-only for one more month as a reference.
5. Archive the sheets and shut off the IFTTT applets.

---


---

## 19. Roadmap

Two tracks run side by side. The **ledger track** (budgets, plans, imports, categorization, reports) doesn't depend on message shapes, so it proceeds at full speed. The **discovery track** starts at once, because the shapes of Chase alerts, receipt emails, and some notifications are unknown and the only way to learn them is to capture real ones (D33). Parsers are written from what discovery finds.

### 19.1 What waits for shapes, and what doesn't

| Can be built without knowing the shapes | Waits for discovery |
|---|---|
| Ledger, budgets and versions, plans, earnings, rebalance, close wizard, reports, the pie | Chase alert parser (and confirmation that Chase can email the alerts) |
| Migration and the parity report | Amazon order / shipment email parser and item extraction |
| **CSV upload with a column-mapping wizard**: on the first upload you map the columns once and the profile is saved, so no sample is needed up front | Venmo and PayPal receipt parsers; owner detection from forwarded headers |
| Merchants, rules, the categorization engine, backtests, seeding from the guesser | Wells Fargo daily-notice parser (if it carries transaction text) |
| **Greenlight engine and parsers for the nine observed shapes** (the rows already exist) | Greenlight request, approval, and funding-notice parsers (deferred, D23) |
| Paired-transfer detection from descriptor rules (§8.8) | Tuning of note-matching windows and grace periods |
| PWA shell, web push, prompt types, notification policy | |
| Ingest endpoints, the raw event store, the Shapes page, replay | |

### 19.2 Discovery track (starts in week 1 of Phase 0)

**D0: capture only.** As soon as the server accepts a POST:

- `/ingest/email` and `/ingest/device` store **every** payload raw (body, headers, receive time, source token), **parse nothing, and create no transactions**.
- You set up the receiver mailbox, Gmail forwarding filters (Amazon, Venmo, PayPal), Chase email alerts pointed at the receiver, and a **second IFTTT applet** with a webhook action beside the existing Sheets one. The Sheets applet keeps running (**dual-run**), so nothing is lost and you can compare the two [VERIFY: the webhook action appears to need IFTTT Pro].
- A **Shapes page** clusters raw events by *template fingerprint*, where numbers, dates, amounts, and names are replaced by placeholders. Each cluster shows its count, first and last seen, three examples, and sender or app. Actions: *promote to parser*, *mark as noise*, *needs a look*.
- Greenlight needs no waiting: its nine shapes are parsed from day one, since the IFTTT rows are exactly what IFTTT sends (D34).

**D1: observe.** Capture for at least one full month so monthly items (subscription receipts, the Greenlight plan fee) and whatever Venmo and PayPal activity occurs are seen. Review the Shapes page weekly; export fixtures.

**D2: adapt.** Write each parser from real samples, then **replay every stored raw event through it** (idempotent). That backfills transactions and notes from the discovery period, so nothing captured is wasted. Set note-matching windows and grace periods from observed timing (how long between a receipt and the posted charge).

**Exit criteria:** every source has a parser or an explicit "ignore" decision; *Unrecognized* stays near zero for a week; the notes matcher hits its target on replayed data.

**Unknown shapes never create transactions by themselves.** An unrecognized event shows its raw text in the Inbox with a manual "create transaction from this message" form, pre-filled by a best-effort amount / date / vendor guess that you confirm. The Shapes page also keeps working after launch, so a changed Chase or receipt format shows up as a new cluster instead of silent loss.

**Your side of D0 (about an hour):** buy the domain and set up DNS, create the GCP project and the e2-micro VM in a free-tier region, create the receiver Gmail, turn on Chase email alerts, add the Gmail filters, add the IFTTT webhook applet, and exempt IFTTT from Android battery optimization.

### 19.3 Phases (ledger track)

| Phase | Delivers | Exit criterion |
|---|---|---|
| **0: Foundations & migration** | Schema, auth, hosting (domain, DNS, TLS), backups, PWA shell; legacy import of all transactions since 2020; **parity report** (run on the unresolved data first); a resolution worksheet for the `NEEDS CATEGORY` leftovers (D32) | P1–P7 clean |
| **1: Replace Phase 2** | Budget page; plans with earnings scenarios and go-live; category history; transfers (rebalance in priority order, pool payment, hand placement, adjustments); splits; transactions page; basic reports including the pie; close wizard | You can run a full month's budget in the app from imported transactions |
| **2: Replace Phase 1** | CSV upload with the column-mapping wizard, de-dup, coverage, backlog mode; merchants, aliases, groups; rules, backtest, and seeding (in `suggest` mode); paired in-system transfers; Greenlight policy engine for both profiles; skill-CSV upload with the notes matcher and item splits; Inbox on web | No spreadsheet needed for ingestion; auto-categorization rate visible |
| **3: Phone & real-time** | Web push, prompts, digest; Chase alerts and receipts wired to the parsers discovery produced; provisional → posted reconciliation; silence alerts | Prompts arrive within minutes of a Chase purchase or Greenlight message; you answer from the phone |
| **4: Analytics (and optionally an aggregator)** | Full chart catalog; Explore; saved searches; SimpleFIN adapter if CSV upload feels like friction | Trends replace spreadsheet insight |
| **5: Optional** | LLM fallback parsing and item-category suggestions, daily verification job, period soft-lock | As desired |

Phase 1 needs only imported transactions, so it ships before any real-time work. Phase 3 is the headline feature; by the time it starts, discovery has already produced the parsers it needs.

---

## 20. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Receipt emails lack the needed detail, or Chase doesn't email the same alerts | medium | notes and fast lane fall back to prompts / CSV | capture-first discovery phase (§19.2), then replay stored raw events through the new parsers; keep the Chrome-skill CSV path; CSV is already an acceptable slow lane |
| Android kills the capture automation | medium | silent Greenlight misses | heartbeat + silence alerts, battery exemption, wallet drift check |
| Parity mismatch on lifetime balances | medium | blocks cut-over | oracle-based tests on every category; explained-differences report |
| Greenlight edge cases (Marion formats, request approvals) | medium | wrong Family Support / Miracle balances | policies are per-profile and configurable; unrecognized messages surface; samples before Phase 2 |
| Double-counting a request | low–medium | wrong envelope balance | requests never post charges (§11.5); tested explicitly |
| False-positive auto-categorization | medium | quiet miscategorization | start in `suggest`; backtest; conflict detection; daily digest; override-rate metric |
| Provisional / posted mismatch (tips, pre-auths) | medium | duplicates or stale rows | tolerance matching, stale handling, duplicate check in close |
| Amazon item splits inexact for multi-shipment orders | high | approximate splits | subset matching, then manual pick; approximations are labeled |
| Scope creep | high | never finishes | phases; non-goals (§2.2) |
| Single-VM failure / data loss | low | high | nightly backup, restore drill |
| Free-tier terms change | low | small cost | re-verify at deploy; code is host-agnostic |
| Gmail receiver breakage (Apps Script quotas / auth) | low | missed alerts | silence alerts; CSV fallback; inbound-mail alternative (§8.5) |
| Greenlight double-charge (funding and allowance both charging) | medium | Miracle Spending overstated | one charging event per wallet (§11.2); a test that funding + allowance never both post; wallet-balance check |
| A notification names no profile (IFTTT sends the body only) | medium | wrong profile attribution | profile is always parsed from the text, never guessed; unattributable messages go to *Unrecognized messages* (§11.8) |
| Legacy reallocation rows mis-detected on migration | medium | misleading reports (balances unaffected) | review list; sheet-compatible mode reproduces the sheet exactly |

---

## 21. Open questions and defaults

**No blocking questions remain.** Resolved since v0.3: Greenlight option A (D29); Venmo cash-outs booked on the bank row and split as needed (D30); zero-out adjustments (D31); `NEEDS CATEGORY` leftovers resolved during migration (D32); a discovery phase for the email and notification shapes (D33); the IFTTT rows as the exact shape (D34); Wells Fargo account granularity (D35).

### 21.1 Defaults I chose (tell me if any is wrong)

1. **Greenlight plan fee.** The recurring −$6.62 `GREENLIGHT APP` rows look like a monthly fee covering both profiles [INFERRED]. Default: category `Fees and Taxes` (the guesser already sends `monthly service fee` there), in `suggest` mode, so the first occurrence asks you to confirm.
2. **Wells Fargo de-dup is scoped to the institution, not the account** (§8.3), so you don't have to say which account a file came from. The account tag is optional.
3. **IFTTT timestamps** are parsed as Pacific, exactly as today's sheet parses them (§11.1).
4. **Transfers to outside accounts stay categorized** (e.g. `Miracle Savings Transfer`), because that money leaves the system (§8.8).
5. **The expected-allowance forecast is on by default** (§11.8), as an accuracy safeguard for the Greenlight model.
6. **Parity runs on the unresolved data first**, and the `NEEDS CATEGORY` resolution is a separate audited step with a before/after balance diff (§18.2).

### 21.2 Answered by discovery, not by you (§19.2)

Chase alert format and whether Chase can email it; Amazon order and shipment emails; Venmo and PayPal receipts as forwarded; Wells Fargo's daily notice text; and, when they occur, the Greenlight **request**, **approval**, and **funding** messages. Each one waits for a captured sample, and nothing else waits on them (§19.1).

### 21.3 To decide later, with real data

- Whether IFTTT stays as the Greenlight capture path long-term or MacroDroid / Tasker replaces it (e.g. if a title or app name is ever needed). This is an adjustment, not a design change (D34).
- Whether the optional aggregator (§8.4) is worth adding after a few months of CSV uploads.

---

## 22. Appendix

### A. Flow: a Chase purchase at a new merchant

1. Chase's alert email reaches the receiver mailbox → forwarder → `raw_events` → parser makes a **provisional** transaction (`SQ *NEW CAFE`, −$9.40, today; time parsed as Eastern).
2. Descriptor cleaned → new `unreviewed` merchant "NEW CAFE". No rule, so `needs_category`. Since it's the shared card and the purchaser is unknown, **both** phones get the push.
3. You tap an action button on the notification (**Eating Out**) → "Always categorize NEW CAFE as Eating Out? (matches 0 past transactions)" → **Suggest next time**. Miracle's duplicate prompt disappears.
4. After the next CSV upload, the posted row matches the provisional, **supersedes** it, and inherits the category. Balance reflects the posted amount.

### B. Flow: an Amazon order across categories

1. Order-confirmation email → receiver → `external_notes` with items: `cat litter $18.99`, `paper towels $11.49`, plus tax and shipping.
2. Two days later the posted card charge arrives via CSV. Descriptor says AMZN → Amazon-only candidates → exact amount, date within window → **auto_matched**.
3. Tax and shipping are allocated proportionally; a rule (`item_name contains "cat litter"` → Pets) suggests one split; the paper towels prompt. Because it's `ask` mode, you confirm both: **Pets −$20.73, Groceries −$10.74**. (Today you do this by eye, e.g. the 20/80 and ⅓–⅔ splits on the 05/30 and 06/28/2026 Amazon rows; a percentage mode stays in the editor.)
4. If the charge covered only part of a multi-shipment order, the matcher shows the item subsets that add up to it and lets you pick.

### C. Flow: more income, new budget

1. **Earnings**: clone the live scenario, change the salary line, name it "After raise".
2. **Plans**: clone the live plan, attach the new scenario, and raise Groceries and Savings until *unallocated* reads $0.
3. **Make live** → dialog: *"Income $X → $Y. 4 categories change (list with old → new). 4 history entries will be created. Effective October 2026."* → Confirm.
4. Atomic write: versions appended, scenario snapshotted onto the plan, previous plan archived, each category's history timeline updated.

### D. Flow: Greenlight, with both profiles (option A)

1. **Allowance:** `$50.00 allowance transferred to Miracle` → Miracle Spending −50. `$100.00 allowance transferred to Marion` → Family Support −100.
2. **Miracle buys dinner:** `Miracle spent $21.83 at El Rinconsito Seattle` → rule Eating Out → `greenlight_reclass`: Eating Out −21.83, Miracle Spending +21.83 (provisional). Two days later `final purchase amount of $25.78 … has posted` → the reclass is re-derived at −25.78 / +25.78.
3. **Marion shops at Walmart:** `Marion spent $7.07 at WAL-MART #3658 …` → `ignored(greenlight_spend)`; no prompt. If a purchase is declined, you get an informational push instead.
4. **Miracle requests money for groceries:** pending request, no charge. When the approval is recorded it books as extra allowance (Miracle Spending −X), then her grocery spend reclassifies (Groceries −X, Miracle Spending +X). Net: Groceries −X.
5. **Money returned:** `↔️ Miracle moved $25.00 from Spend Anywhere to your Wallet` → Miracle Spending +25.
6. **Funding:** the bank row `GREENLIGHT APP 260628 … (50.00)` becomes an `internal_transfer` into the wallet; the wallet balance updates; no envelope is charged.

### E. Flow: paying the credit card

1. Wells Fargo CSV: `CHASE CREDIT CRD AUTOPAY … (−X)`. A descriptor rule marks it `internal_transfer` immediately.
2. Chase CSV, uploaded later: `PAYMENT THANK YOU - WEB +X`. A rule marks it `internal_transfer`, and pairing links the two legs. Neither touches the budget; the purchases on the card already did.
3. If the Chase leg never shows up after its CSV covers that date, the Wells Fargo leg is flagged for review (§8.8).

### F. What I'd do first, concretely

1. **Phase 0 and D0 together.** Stand up the server, then immediately start capturing (D0) so the shapes accumulate while the ledger track is built. The Greenlight parsers can be built right away from your existing rows.
2. The first deliverable is still the parity report: schema, migration, and the P1–P7 check. It needs no UI and tells you whether the whole model is right.
3. Phase 1 next, since it needs only imported transactions and replaces your Phase 2 end to end.
