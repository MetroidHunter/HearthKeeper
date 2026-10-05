import { audit, type DB } from '../core/db.js';
import { createTransaction, setSplits, suggestCategory } from '../core/transactions.js';
import { daysBetween, pacificDateOfUtc } from '../core/time.js';
import { parseGreenlight, type GreenlightEvent } from './parse.js';
import { emitNotify } from '../notify/bus.js';

export interface Profile { id: number; display_name: string; name_pattern: string; category_id: number; wallet_account_id: number; spend_policy: 'ignore' | 'reclassify'; request_policy: 'as_allowance' | 'ask_category'; withdraw_policy: string; active: number }

export type GreenlightOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'unrecognized'; reason: string }
  | { outcome: 'noise'; reason: string }
  | { outcome: 'inform'; message: string }
  | { outcome: 'expected_allowance'; id: number }
  | { outcome: 'request'; requestId: number }
  | { outcome: 'withdraw_ignored' | 'withdraw_flagged' | 'withdraw_debited'; txnId: number }
  | { outcome: 'allowance' | 'return' | 'spend_ignored' | 'spend_reclassified' | 'spend_updated' | 'savings_reward'; txnId: number | null };

/** Profile always comes from the message text; no match => null => Unrecognized (design §11.8 #1). Never guessed. */
export function findProfile(db: DB, name: string): Profile | null {
  const ps = db.prepare('SELECT * FROM greenlight_profiles WHERE active=1').all() as Profile[];
  const hits = ps.filter((p) => new RegExp(p.name_pattern, 'i').test(name));
  return hits.length === 1 ? hits[0] : null; // ambiguous => also unattributable
}

function spendKey(profileId: number, vendor: string, date: string, cents: number) { return `spend:${profileId}:${vendor.toLowerCase()}:${date}:${cents}`; }

/** Process one captured Greenlight message. Idempotent per raw_event_id (replay-safe, §8.2). */
export function processGreenlightMessage(db: DB, rawEventId: number, text: string, arrivedAtUtc: string): GreenlightOutcome {
  const seen = db.prepare('SELECT outcome FROM greenlight_processed WHERE raw_event_id=?').get(rawEventId);
  if (seen) return { outcome: 'duplicate' };
  const done = (o: GreenlightOutcome, txnId?: number | null): GreenlightOutcome => {
    // unrecognized/noise are not terminal: a parser improvement + replay must be able to reprocess them
    if (o.outcome === 'unrecognized' || o.outcome === 'noise') return o;
    db.prepare('INSERT INTO greenlight_processed(raw_event_id, outcome, txn_id, detail_json) VALUES (?,?,?,?)').run(rawEventId, o.outcome, txnId ?? null, JSON.stringify(o));
    return o;
  };
  return db.transaction(() => {
    const p = parseGreenlight(text);
    const ev = p.event;
    const at = p.occurredAtUtc ?? arrivedAtUtc;
    const date = p.pacificDate ?? pacificDateOfUtc(arrivedAtUtc);
    if (ev.type === 'unrecognized') return done({ outcome: 'unrecognized', reason: ev.reason });
    if (ev.type === 'noise') return done({ outcome: 'noise', reason: ev.reason });
    if (ev.type === 'savings_reward') return done({ outcome: 'noise', reason: 'savings_reward' });

    const profile = findProfile(db, (ev as { profile: string }).profile);
    if (!profile) return done({ outcome: 'unrecognized', reason: `unknown_profile:${(ev as any).profile}` });

    switch (ev.type) {
      case 'allowance_reminder': {
        const id = Number(db.prepare('INSERT INTO greenlight_expected_allowances(profile_id, amount_cents, expected_on, raw_event_id) VALUES (?,?,?,?)')
          .run(profile.id, ev.amountCents, addDay(date, 1), rawEventId).lastInsertRowid);
        return done({ outcome: 'expected_allowance', id });
      }
      case 'allowance': {
        // Under option A, the allowance is the (only) charging event for the profile's category (§11.2).
        const id = createTransaction(db, { accountId: profile.wallet_account_id, kind: 'greenlight_allowance', occurredOn: date, authorizedAt: at, amountCents: -ev.amountCents,
          descriptor: `GREENLIGHT ALLOWANCE ${profile.display_name}`, sourceEventIds: [rawEventId], greenlightRef: `allowance:${rawEventId}` });
        setSplits(db, id, [{ categoryId: profile.category_id, amountCents: -ev.amountCents, origin: 'rule' }], 'rule');
        const exp = db.prepare(`SELECT id, expected_on FROM greenlight_expected_allowances WHERE profile_id=? AND amount_cents=? AND fulfilled_txn_id IS NULL AND ABS(julianday(expected_on)-julianday(?))<=3 ORDER BY ABS(julianday(expected_on)-julianday(?)), expected_on LIMIT 1`).get(profile.id, ev.amountCents, date, date) as any;
        if (exp) db.prepare('UPDATE greenlight_expected_allowances SET fulfilled_txn_id=? WHERE id=?').run(id, exp.id);
        return done({ outcome: 'allowance', txnId: id }, id);
      }
      case 'return': {
        const id = createTransaction(db, { accountId: profile.wallet_account_id, kind: 'greenlight_return', occurredOn: date, authorizedAt: at, amountCents: ev.amountCents,
          descriptor: `GREENLIGHT RETURN ${profile.display_name}`, sourceEventIds: [rawEventId], greenlightRef: `return:${rawEventId}` });
        setSplits(db, id, [{ categoryId: profile.category_id, amountCents: ev.amountCents, origin: 'rule' }], 'rule');
        return done({ outcome: 'return', txnId: id }, id);
      }
      case 'declined': {
        const message = `${profile.display_name}'s ${(ev.amountCents / 100).toFixed(2)} at ${ev.vendor} was declined${ev.control ? `: ${ev.control} control` : ev.reason ? `: ${ev.reason}` : ''}`;
        emitNotify({ type: 'greenlight_inform', message, profile: profile.display_name });
        return done({ outcome: 'inform', message });
      }
      case 'request': {
        // never posts a charge by itself (§11.5); the approval message is unseen so the pending request asks you (D23)
        const requestId = createRequest(db, profile.id, ev.amountCents, date, rawEventId);
        emitNotify({ type: 'greenlight_request', requestId });
        return done({ outcome: 'request', requestId });
      }
      case 'withdraw': {
        // Under option A the allowance already charged the profile's category, so a withdrawal never re-charges unless the policy says so.
        const policy = profile.withdraw_policy;
        const flagged = policy === 'ask';
        const id = createTransaction(db, { accountId: profile.wallet_account_id, kind: policy === 'debit_category' ? 'greenlight_allowance' : 'ignored', occurredOn: date, authorizedAt: at, amountCents: -ev.amountCents,
          descriptor: `GREENLIGHT ATM WITHDRAW ${ev.vendor}`, sourceEventIds: [rawEventId], greenlightRef: `withdraw:${profile.id}:${rawEventId}`,
          ignoredReason: policy === 'debit_category' ? null : 'greenlight_withdraw', flagged, flagReason: flagged ? `${profile.display_name} withdrew ${(ev.amountCents / 100).toFixed(2)} at ${ev.vendor}: categorize or ignore` : null });
        if (policy === 'debit_category') setSplits(db, id, [{ categoryId: profile.category_id, amountCents: -ev.amountCents, origin: 'rule' }], 'rule');
        if (flagged) emitNotify({ type: 'needs_you', txnId: id, lane: 'fast' });
        return done({ outcome: policy === 'debit_category' ? 'withdraw_debited' : flagged ? 'withdraw_flagged' : 'withdraw_ignored', txnId: id }, id);
      }
      case 'spend': return done(handleSpend(db, profile, ev, rawEventId, date, at));
      case 'final_amount': return done(handleFinal(db, profile, ev, rawEventId, date));
    }
  })();
}

function addDay(d: string, n: number): string {
  const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10);
}

function handleSpend(db: DB, profile: Profile, ev: Extract<GreenlightEvent, { type: 'spend' }>, rawEventId: number, date: string, at: string): GreenlightOutcome {
  const ref = spendKey(profile.id, ev.vendor, date, ev.amountCents) + `:${rawEventId}`;
  if (profile.spend_policy === 'ignore') {
    const id = createTransaction(db, { accountId: profile.wallet_account_id, kind: 'ignored', status: 'provisional', occurredOn: date, authorizedAt: at, amountCents: -ev.amountCents,
      descriptor: ev.vendor, ignoredReason: 'greenlight_spend', sourceEventIds: [rawEventId], greenlightRef: ref });
    return { outcome: 'spend_ignored', txnId: id };
  }
  // reclassify: the allowance already charged Miracle's category; the reclass only re-attributes (Σ splits = 0, §6.2).
  const acct = db.prepare('SELECT name FROM accounts WHERE id=?').get(profile.wallet_account_id) as { name: string };
  const sug = suggestCategory(db, ev.vendor, -ev.amountCents, acct.name, 'greenlight');
  const id = createTransaction(db, { accountId: profile.wallet_account_id, kind: 'greenlight_reclass', status: 'provisional', occurredOn: date, authorizedAt: at, amountCents: 0,
    descriptor: ev.vendor, sourceEventIds: [rawEventId], greenlightRef: ref });
  writeReclass(db, id, profile, ev.amountCents, sug.categoryId !== profile.category_id ? sug.categoryId : null, sug);
  if ((db.prepare('SELECT review_state r FROM transactions WHERE id=?').get(id) as { r: string }).r === 'needs_category') emitNotify({ type: 'needs_you', txnId: id, lane: 'fast' });
  return { outcome: 'spend_reclassified', txnId: id };
}

function writeReclass(db: DB, id: number, profile: Profile, cents: number, realCat: number | null, sug: { mode: string; ruleId?: number }) {
  // A resolved category under `auto` is applied; under `suggest`/`ask` the real-category split is left null so it prompts (with the rule as the pre-selected hint).
  const apply = realCat !== null && sug.mode === 'auto';
  const first = apply ? realCat : null;
  if (realCat !== null && sug.mode === 'suggest') db.prepare("UPDATE transactions SET decided_rule_id=?, decided_by='rule' WHERE id=?").run(sug.ruleId ?? null, id);
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(id);
  const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?,?)');
  ins.run(id, first, -cents, 'greenlight_reclass');
  ins.run(id, profile.category_id, cents, 'greenlight_reclass');
  db.prepare("UPDATE transactions SET review_state=? WHERE id=?").run(apply ? 'auto_categorized' : 'needs_category', id);
}

function handleFinal(db: DB, profile: Profile, ev: Extract<GreenlightEvent, { type: 'final_amount' }>, rawEventId: number, date: string): GreenlightOutcome {
  // Match the earlier spend: same profile, similar vendor, within 10 days, not yet finalized.
  const prefix = `spend:${profile.id}:`;
  const cands = db.prepare(`SELECT id, greenlight_ref, occurred_on, descriptor_raw, status, CASE WHEN amount_cents=0 THEN COALESCE((SELECT -SUM(amount_cents) FROM transaction_splits WHERE transaction_id=transactions.id AND amount_cents>0),0) ELSE -amount_cents END AS spend_cents FROM transactions WHERE greenlight_ref LIKE ? AND status='provisional' ORDER BY occurred_on DESC`).all(prefix + '%') as any[];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Score every candidate: vendor containment beats a lone shared token; then closest amount, then closest date.
  // A token-only match is accepted only when it is the single plausible candidate (never guess between two).
  const scored = cands.filter((c) => Math.abs(daysBetween(c.occurred_on, date)) <= 10).map((c) => {
    const a = norm(c.descriptor_raw), b = norm(ev.vendor);
    const tier = a && b && (a.includes(b) || b.includes(a)) ? 2 : sharedTokens(c.descriptor_raw, ev.vendor) ? 1 : 0;
    return { c, tier, amt: Math.abs(Math.abs(c.spend_cents) - ev.amountCents), dd: Math.abs(daysBetween(c.occurred_on, date)) };
  }).filter((x) => x.tier > 0).sort((x, y) => y.tier - x.tier || x.amt - y.amt || x.dd - y.dd);
  const best = scored[0];
  const ambiguousToken = best && best.tier === 1 && scored.length > 1;
  const match = best && !ambiguousToken ? best.c : undefined;
  if (!match) {
    // Finalization with no earlier spend seen: treat it as a fresh (already final) spend.
    const out = handleSpend(db, profile, { type: 'spend', profile: ev.profile, amountCents: ev.amountCents, vendor: ev.vendor }, rawEventId, date, date + 'T12:00:00Z');
    if ('txnId' in out && out.txnId) db.prepare("UPDATE transactions SET status='posted' WHERE id=?").run(out.txnId);
    return out;
  }
  const t = db.prepare('SELECT kind, source_event_ids FROM transactions WHERE id=?').get(match.id) as any;
  const before = db.prepare('SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id=?').all(match.id);
  if (t.kind === 'greenlight_reclass') {
    const real = db.prepare("SELECT category_id FROM transaction_splits WHERE transaction_id=? AND amount_cents<0").get(match.id) as any;
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(match.id);
    const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?,?)');
    ins.run(match.id, real?.category_id ?? null, -ev.amountCents, 'greenlight_reclass');
    ins.run(match.id, profile.category_id, ev.amountCents, 'greenlight_reclass');
  } else {
    db.prepare('UPDATE transactions SET amount_cents=? WHERE id=?').run(-ev.amountCents, match.id);
  }
  db.prepare("UPDATE transactions SET status='posted', source_event_ids=?, version=version+1 WHERE id=?").run(JSON.stringify([...JSON.parse(t.source_event_ids), rawEventId]), match.id);
  audit(db, 'transaction', match.id, 'greenlight_final_amount', before, { amountCents: ev.amountCents });
  return { outcome: 'spend_updated', txnId: match.id };
}
function sharedTokens(a: string, b: string): boolean {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3));
  return b.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3).some((x) => ta.has(x));
}

/** Requests never post a charge by themselves (§11.5, §7.8). */
export function createRequest(db: DB, profileId: number, amountCents: number, requestedAt: string, rawEventId?: number): number {
  return Number(db.prepare('INSERT INTO greenlight_requests(profile_id, amount_cents, requested_at, raw_event_id) VALUES (?,?,?,?)').run(profileId, amountCents, requestedAt, rawEventId ?? null).lastInsertRowid);
}

/** Record the money movement for an approved request, per profile policy. Idempotent: a funded request can't be funded twice. */
export function fundRequest(db: DB, requestId: number, occurredOn: string, chosenCategoryId?: number): number {
  return db.transaction(() => {
    const r = db.prepare('SELECT * FROM greenlight_requests WHERE id=?').get(requestId) as any;
    if (r.status !== 'pending') throw new Error(`request ${requestId} is ${r.status}`);
    const p = db.prepare('SELECT * FROM greenlight_profiles WHERE id=?').get(r.profile_id) as Profile;
    let cat = p.category_id;
    if (p.request_policy === 'ask_category') { if (!chosenCategoryId) throw new Error('this profile requires a category for approved requests'); cat = chosenCategoryId; }
    const id = createTransaction(db, { accountId: p.wallet_account_id, kind: 'greenlight_allowance', occurredOn, amountCents: -r.amount_cents, descriptor: `GREENLIGHT REQUEST ${p.display_name}`, greenlightRef: `request:${requestId}` });
    setSplits(db, id, [{ categoryId: cat, amountCents: -r.amount_cents, origin: 'rule' }], 'rule');
    db.prepare("UPDATE greenlight_requests SET status='funded', funded_txn_id=?, chosen_category_id=? WHERE id=?").run(id, cat, requestId);
    return id;
  })();
}

/** Wallet balance = funding - allowances + returns (§11.2). Funding rows are bank rows `GREENLIGHT APP ...` classified internal_transfer. */
export function walletBalance(db: DB, walletAccountId: number): number {
  const funding = (db.prepare(`SELECT COALESCE(SUM(-amount_cents),0) v FROM transactions WHERE kind='internal_transfer' AND UPPER(descriptor_raw) LIKE 'GREENLIGHT APP%' AND status!='void'`).get() as any).v;
  const flows = (db.prepare(`SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE account_id=? AND kind IN ('greenlight_allowance','greenlight_return') AND status!='void'`).get(walletAccountId) as any).v;
  return funding + flows;
}

export function missingAllowances(db: DB, today: string): { id: number; profile_id: number; amount_cents: number; expected_on: string }[] {
  return (db.prepare('SELECT id, profile_id, amount_cents, expected_on FROM greenlight_expected_allowances WHERE fulfilled_txn_id IS NULL').all() as any[]).filter((e) => daysBetween(e.expected_on, today) > 2);
}

/** Attribution property (§11.8 #3): every split on a Greenlight event for profile X touches only X's category or a real (non-profile) category. */
export function attributionViolations(db: DB): string[] {
  const profiles = db.prepare('SELECT id, display_name, category_id FROM greenlight_profiles').all() as any[];
  const out: string[] = [];
  const rows = db.prepare(`SELECT t.id, t.greenlight_ref, t.kind, s.category_id FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.greenlight_ref IS NOT NULL`).all() as any[];
  for (const r of rows) {
    const m = /^spend:(\d+):/.exec(r.greenlight_ref);
    const owner = m ? Number(m[1]) : null;
    if (owner === null) continue;
    for (const other of profiles) if (other.id !== owner && other.category_id === r.category_id)
      out.push(`txn ${r.id} (profile ${owner}) touches profile ${other.display_name}'s category`);
  }
  // Allowance / return transactions: map via descriptor name.
  const allow = db.prepare(`SELECT t.id, t.descriptor_raw, s.category_id FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.kind IN ('greenlight_allowance','greenlight_return') AND t.greenlight_ref LIKE 'allowance:%' OR t.greenlight_ref LIKE 'return:%'`).all() as any[];
  for (const r of allow) {
    const prof = profiles.find((p) => r.descriptor_raw.toUpperCase().endsWith(p.display_name.toUpperCase()));
    if (prof && prof.category_id !== r.category_id) out.push(`txn ${r.id} (${prof.display_name}) charged to wrong category`);
  }
  return out;
}
