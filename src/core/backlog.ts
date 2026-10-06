import { audit, type DB } from './db.js';
import { suggestionsFor } from './reports.js';
import { backtest, addRule, type RuleMatch } from './rules.js';
import { setSplits } from './transactions.js';

/**
 * Backlog mode (design §8.3): a large import opens a batch review grouped by merchant instead of sending a push per row.
 * One answer applies to every transaction in the group; optionally it teaches a merchant rule (with its backtest).
 */
export interface BacklogGroup { key: string; merchantId: number | null; name: string; count: number; totalCents: number; txnIds: number[]; samples: string[]; txns: { id: number; occurred_on: string; amount_cents: number; descriptor_raw: string; account: string }[]; suggestions: { id: number; name: string; why: string }[] }

export function groupedInbox(db: DB): BacklogGroup[] {
  const rows = db.prepare(`SELECT t.id, t.merchant_id mid, COALESCE(m.name, t.descriptor_clean, t.descriptor_raw) name, t.amount_cents a, t.descriptor_raw d, t.decided_rule_id rule, t.occurred_on od, ac.name acct
    FROM transactions t LEFT JOIN merchants m ON m.id=t.merchant_id JOIN accounts ac ON ac.id=t.account_id WHERE t.status!='void' AND t.review_state='needs_category' AND t.kind NOT IN ('ignored','internal_transfer','greenlight_reclass') ORDER BY t.occurred_on DESC`).all() as any[];
  const groups = new Map<string, BacklogGroup & { rule: number | null; desc: string }>();
  for (const r of rows) {
    const key = r.mid ? `m${r.mid}` : `d${String(r.name).toLowerCase()}`;
    const g: BacklogGroup & { rule: number | null; desc: string } = groups.get(key) ?? { key, merchantId: r.mid, name: r.name, count: 0, totalCents: 0, txnIds: [], samples: [], txns: [], suggestions: [], rule: r.rule, desc: r.name };
    g.count++; g.totalCents += r.a; g.txnIds.push(r.id); if (g.txns.length < 200) g.txns.push({ id: r.id, occurred_on: r.od, amount_cents: r.a, descriptor_raw: r.d, account: r.acct }); if (g.samples.length < 3 && !g.samples.includes(r.d)) g.samples.push(r.d);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ rule, desc, ...g }) => ({ ...g, suggestions: suggestionsFor(db, { id: g.txnIds[0], decided_rule_id: rule, descriptor_clean: desc }) })).sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents));
}

export interface BulkResult { applied: number; skipped: number; rule?: { id: number; backtest: ReturnType<typeof backtest> } }
/** Apply one category to many transactions (only ones still waiting; a human decision made meanwhile is never overwritten). */
export function bulkAnswer(db: DB, txnIds: number[], categoryId: number, opts: { makeRule?: 'auto' | 'suggest'; actor?: string } = {}): BulkResult {
  const cat = db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) as { name: string } | undefined;
  if (!cat) throw new Error('unknown category');
  let applied = 0, skipped = 0, merchantId: number | null = null;
  db.transaction(() => {
    for (const id of txnIds) {
      const t = db.prepare("SELECT amount_cents a, review_state rs, kind, merchant_id m, status FROM transactions WHERE id=?").get(id) as any;
      if (!t || t.rs !== 'needs_category' || t.status === 'void' || ['ignored', 'internal_transfer', 'greenlight_reclass'].includes(t.kind)) { skipped++; continue; }
      setSplits(db, id, [{ categoryId, amountCents: t.a }], 'user'); applied++; merchantId ??= t.m;
    }
    audit(db, 'backlog', txnIds.length, 'bulk_categorize', undefined, { categoryId, applied, skipped }, opts.actor ?? 'user');
  })();
  let rule: BulkResult['rule'];
  if (opts.makeRule && merchantId) {
    const m = db.prepare('SELECT name FROM merchants WHERE id=?').get(merchantId) as { name: string };
    const match: RuleMatch = { all_of: [{ field: 'merchant', op: 'eq', value: m.name }] };
    rule = { id: addRule(db, { match, action: { type: 'categorize', category: cat.name }, mode: opts.makeRule, origin: 'learned', notes: `learned from backlog review of ${m.name}` }), backtest: backtest(db, { match }) };
  }
  return { applied, skipped, rule };
}
