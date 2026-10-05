import { audit, type DB } from './db.js';
import { cleanDescriptor } from './descriptor.js';
import { decide, loadRules, type Candidate, type Rule } from './rules.js';

export type Kind = 'spending' | 'income' | 'internal_transfer' | 'greenlight_allowance' | 'greenlight_return' | 'greenlight_reclass' | 'ignored';
export interface NewTxn {
  accountId: number; kind?: Kind; status?: 'provisional' | 'posted'; occurredOn: string; postedOn?: string | null; authorizedAt?: string | null; amountCents: number;
  descriptor?: string; ownerUserId?: number | null; note?: string | null; sourceEventIds?: number[]; fingerprint?: string | null; greenlightRef?: string | null;
  ignoredReason?: string | null; legacyGroup?: string | null; noteState?: string; flagged?: boolean; flagReason?: string | null;
}
export interface SplitIn { categoryId: number | null; amountCents: number; memo?: string; origin?: 'user' | 'rule' | 'item' | 'greenlight_reclass' | 'legacy' }

export function getCategoryId(db: DB, name: string): number | null {
  const r = db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(name) as { id: number } | undefined;
  return r?.id ?? null;
}

export function createTransaction(db: DB, t: NewTxn): number {
  const clean = cleanDescriptor(t.descriptor ?? '', { year: Number(t.occurredOn.slice(0, 4)) });
  const id = Number(db.prepare(`INSERT INTO transactions(account_id,owner_user_id,kind,status,occurred_on,posted_on,authorized_at,amount_cents,descriptor_raw,descriptor_clean,location_hint,
      review_state,note,note_state,flagged,flag_reason,ignored_reason,legacy_group,source_event_ids,fingerprint,greenlight_ref)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    t.accountId, t.ownerUserId ?? null, t.kind ?? 'spending', t.status ?? 'posted', t.occurredOn, t.postedOn ?? null, t.authorizedAt ?? null, t.amountCents,
    t.descriptor ?? '', clean.clean, clean.locationHint, (t.kind === 'ignored' || t.kind === 'internal_transfer') ? 'not_needed' : 'needs_category',
    t.note ?? null, t.noteState ?? 'not_needed', t.flagged ? 1 : 0, t.flagReason ?? null, t.ignoredReason ?? null, t.legacyGroup ?? null,
    JSON.stringify(t.sourceEventIds ?? []), t.fingerprint ?? null, t.greenlightRef ?? null).lastInsertRowid);
  return id;
}

/** Replace a transaction's splits, enforcing the §7.8 invariants. Null category = needs_category. */
export function setSplits(db: DB, txnId: number, splits: SplitIn[], decidedBy: 'rule' | 'user' | 'merchant_default' = 'user', ruleId?: number): void {
  const t = db.prepare('SELECT kind, amount_cents FROM transactions WHERE id=?').get(txnId) as { kind: Kind; amount_cents: number };
  const sum = splits.reduce((a, s) => a + s.amountCents, 0);
  if (t.kind === 'greenlight_reclass') { if (sum !== 0) throw new Error('reclass splits must sum to 0'); }
  else if (t.kind === 'internal_transfer' || t.kind === 'ignored') { if (splits.length) throw new Error(`${t.kind} transactions carry no splits`); }
  else if (sum !== t.amount_cents) throw new Error(`splits (${sum}) must equal amount (${t.amount_cents})`);
  db.transaction(() => {
    const before = db.prepare('SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id=?').all(txnId);
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(txnId);
    const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,?)');
    for (const s of splits) ins.run(txnId, s.categoryId, s.amountCents, s.memo ?? null, s.origin ?? (decidedBy === 'rule' ? 'rule' : 'user'));
    const complete = splits.length > 0 && splits.every((s) => s.categoryId !== null);
    const review = !complete && t.kind !== 'greenlight_reclass' ? 'needs_category' : decidedBy === 'user' ? 'user_confirmed' : 'auto_categorized';
    db.prepare('UPDATE transactions SET review_state=?, decided_by=?, decided_rule_id=?, version=version+1 WHERE id=?').run(review, decidedBy, ruleId ?? null, txnId);
    audit(db, 'transaction_splits', txnId, 'set', before, splits, decidedBy);
  })();
}

export function ignoreTransaction(db: DB, txnId: number, reason: string, actor = 'system'): void {
  db.transaction(() => {
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(txnId);
    db.prepare("UPDATE transactions SET kind='ignored', ignored_reason=?, review_state='not_needed', version=version+1 WHERE id=?").run(reason, txnId);
    audit(db, 'transaction', txnId, 'ignore', undefined, { reason }, actor);
  })();
}

export function restoreTransaction(db: DB, txnId: number, kind: 'spending' | 'income' = 'spending'): void {
  const t = db.prepare('SELECT amount_cents FROM transactions WHERE id=?').get(txnId) as { amount_cents: number };
  db.prepare("UPDATE transactions SET kind=?, ignored_reason=NULL, review_state='needs_category', version=version+1 WHERE id=?").run(kind === 'spending' && t.amount_cents > 0 ? 'income' : kind, txnId);
  audit(db, 'transaction', txnId, 'restore', undefined, undefined, 'user');
}

export interface ResolveOpts { readOnly?: boolean; rules?: Rule[]; aliases?: any[]; merchantsByName?: Map<string, number> }
export function resolveMerchant(db: DB, clean: string, raw: string, opts: ResolveOpts = {}): number | null {
  if (!clean) return null;
  const aliases = opts.aliases ?? (db.prepare('SELECT merchant_id, match_type, pattern, priority FROM merchant_aliases ORDER BY priority, id').all() as any[]);
  const hay = raw.toLowerCase();
  for (const a of aliases) {
    const p = String(a.pattern).toLowerCase();
    const ok = a.match_type === 'contains' ? hay.includes(p)
      : a.match_type === 'starts_with' ? clean.toLowerCase().startsWith(p)
      : a.match_type === 'word' ? new RegExp(`(?<![a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(hay)
      : new RegExp(a.pattern, 'i').test(raw);
    if (ok) return a.merchant_id;
  }
  const ex = opts.merchantsByName ? { id: opts.merchantsByName.get(clean.toLowerCase()) } : (db.prepare('SELECT id FROM merchants WHERE name=? COLLATE NOCASE').get(clean) as { id: number } | undefined);
  if (ex?.id) return ex.id;
  if (opts.readOnly) return null; // backtests must not create merchants
  return Number(db.prepare("INSERT INTO merchants(name, review_state) VALUES (?, 'unreviewed')").run(clean).lastInsertRowid); // unknown descriptors auto-create an unreviewed merchant
}

export interface ClassifyResult { outcome: 'internal_transfer' | 'ignored' | 'categorized' | 'suggested' | 'needs_category' | 'untouched'; ruleId?: number; categoryId?: number; conflict?: boolean }

/**
 * Order of operations (design §9.1): kind classification -> merchant -> rules -> decision.
 * Idempotent: never touches a user_confirmed transaction (§8.2).
 */
export function classify(db: DB, txnId: number, extra: Partial<Candidate> = {}): ClassifyResult {
  const t = db.prepare(`SELECT t.*, a.name account_name FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(txnId) as any;
  if (t.review_state === 'user_confirmed' || t.kind === 'ignored' || t.kind === 'internal_transfer' && t.decided_by === 'user') return { outcome: 'untouched' };
  const merchantId = resolveMerchant(db, t.descriptor_clean, t.descriptor_raw);
  db.prepare('UPDATE transactions SET merchant_id=? WHERE id=?').run(merchantId, txnId);
  const merchant = merchantId ? (db.prepare('SELECT name, default_category_id, default_mode FROM merchants WHERE id=?').get(merchantId) as any) : null;
  const groups = merchantId ? (db.prepare('SELECT g.name FROM merchant_group_members m JOIN merchant_groups g ON g.id=m.group_id WHERE m.merchant_id=?').all(merchantId) as any[]).map((g) => g.name) : [];
  const cand: Candidate = { descriptor: `${t.descriptor_raw} ${t.descriptor_clean ?? ''}`, merchant: merchant?.name, merchant_group: groups, account: t.account_name, amount_cents: t.amount_cents,
    direction: t.amount_cents < 0 ? 'out' : 'in', note: t.note ?? undefined, ...extra };
  const d = decide(loadRules(db), cand);
  if (d.rule) {
    db.prepare('UPDATE rules SET hit_count=hit_count+1, last_hit_at=datetime(\'now\') WHERE id=?').run(d.rule.id);
    const a = d.rule.action;
    if (a.type === 'internal_transfer') {
      db.prepare("UPDATE transactions SET kind='internal_transfer', ignored_reason=?, review_state='not_needed', decided_by='rule', decided_rule_id=?, version=version+1 WHERE id=?").run(a.reason ?? 'internal_transfer', d.rule.id, txnId);
      db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(txnId);
      return { outcome: 'internal_transfer', ruleId: d.rule.id };
    }
    if (a.type === 'ignore') { ignoreTransaction(db, txnId, a.reason ?? 'rule'); return { outcome: 'ignored', ruleId: d.rule.id }; }
    const cid = a.category ? getCategoryId(db, a.category) : null;
    if (cid && !d.conflicts.length) return applyCategory(db, t, txnId, cid, d.rule.mode, d.rule.id);
    if (d.conflicts.length) return { outcome: 'needs_category', ruleId: d.rule.id, conflict: true };
  }
  if (merchant?.default_category_id) return applyCategory(db, t, txnId, merchant.default_category_id, merchant.default_mode, undefined);
  return { outcome: 'needs_category' };
}

function applyCategory(db: DB, t: any, txnId: number, cid: number, mode: string, ruleId?: number): ClassifyResult {
  if (t.kind === 'greenlight_reclass') return { outcome: 'needs_category' };
  // `ask` => no default; `suggest` => pending suggestion; `auto` => apply. Suggestions are stored as a null-category split with a memo hint.
  if (mode === 'auto') {
    setSplits(db, txnId, [{ categoryId: cid, amountCents: t.amount_cents, origin: 'rule' }], 'rule', ruleId);
    return { outcome: 'categorized', ruleId, categoryId: cid };
  }
  if (mode === 'suggest') {
    db.prepare("UPDATE transactions SET review_state='needs_category', decided_rule_id=?, decided_by='rule' WHERE id=?").run(ruleId ?? null, txnId);
    return { outcome: 'suggested', ruleId, categoryId: cid };
  }
  return { outcome: 'needs_category', ruleId };
}

export interface CategorySuggestion { categoryId: number | null; mode: 'auto' | 'suggest' | 'ask'; ruleId?: number; conflict?: boolean; outcome?: 'ignore' | 'internal_transfer' }
/** Merchant + rules resolution without needing a stored transaction (used by the Greenlight reclass path, §11.4). */
export function suggestCategory(db: DB, descriptorRaw: string, amountCents: number, accountName: string, source?: string, opts: ResolveOpts = {}): CategorySuggestion {
  const clean = cleanDescriptor(descriptorRaw);
  const merchantId = resolveMerchant(db, clean.clean, descriptorRaw, opts);
  const merchant = merchantId ? (db.prepare('SELECT name, default_category_id, default_mode FROM merchants WHERE id=?').get(merchantId) as any) : null;
  const groups = merchantId ? (db.prepare('SELECT g.name FROM merchant_group_members m JOIN merchant_groups g ON g.id=m.group_id WHERE m.merchant_id=?').all(merchantId) as any[]).map((g) => g.name) : [];
  const d = decide(opts.rules ?? loadRules(db), { descriptor: `${descriptorRaw} ${clean.clean}`, merchant: merchant?.name, merchant_group: groups, account: accountName, amount_cents: amountCents, direction: amountCents < 0 ? 'out' : 'in', source });
  if (d.rule) {
    if (!opts.readOnly) db.prepare("UPDATE rules SET hit_count=hit_count+1, last_hit_at=datetime('now') WHERE id=?").run(d.rule.id);
    const a = d.rule.action;
    if (a.type === 'ignore' || a.type === 'internal_transfer') return { categoryId: null, mode: d.rule.mode, ruleId: d.rule.id, outcome: a.type };
    const cid = a.category ? getCategoryId(db, a.category) : null;
    return { categoryId: d.conflicts.length ? null : cid, mode: d.rule.mode, ruleId: d.rule.id, conflict: d.conflicts.length > 0 };
  }
  if (merchant?.default_category_id) return { categoryId: merchant.default_category_id, mode: merchant.default_mode };
  return { categoryId: null, mode: 'ask' };
}
