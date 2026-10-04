import type { DB } from './db.js';
import { audit } from './db.js';
import { backtest, addRule, type RuleMatch } from './rules.js';
import { setSplits, getCategoryId, type SplitIn } from './transactions.js';

export type RuleChoice = 'auto' | 'suggest' | 'once';

/**
 * A user's category answer (design §9.6, §15.4). Tracks clean confirmations / overrides on the suggesting rule,
 * and optionally creates a merchant-based rule with its backtest shown first.
 */
export function answerCategory(db: DB, txnId: number, splits: SplitIn[], opts: { makeRule?: RuleChoice; actor?: string } = {}) {
  const t = db.prepare('SELECT decided_rule_id, merchant_id, review_state, amount_cents, descriptor_clean FROM transactions WHERE id=?').get(txnId) as any;
  let suggested: number | null = null;
  if (t.decided_rule_id) {
    const r = db.prepare('SELECT action_json FROM rules WHERE id=?').get(t.decided_rule_id) as any;
    const cat = r ? JSON.parse(r.action_json).category : null;
    suggested = cat ? getCategoryId(db, cat) : null;
  }
  setSplits(db, txnId, splits, 'user');
  if (t.decided_rule_id && t.review_state === 'needs_category') {
    const same = splits.length === 1 && splits[0].categoryId === suggested;
    db.prepare(`UPDATE rules SET ${same ? 'clean_confirmations=clean_confirmations+1' : 'override_count=override_count+1'} WHERE id=?`).run(t.decided_rule_id);
  }
  let rule: { id: number; backtest: ReturnType<typeof backtest> } | undefined;
  if ((opts.makeRule === 'auto' || opts.makeRule === 'suggest') && t.merchant_id && splits.length === 1 && splits[0].categoryId) {
    const m = db.prepare('SELECT name FROM merchants WHERE id=?').get(t.merchant_id) as { name: string };
    const cat = db.prepare('SELECT name FROM categories WHERE id=?').get(splits[0].categoryId) as { name: string };
    const match: RuleMatch = { all_of: [{ field: 'merchant', op: 'eq', value: m.name }] };
    const bt = backtest(db, { match });
    const id = addRule(db, { match, action: { type: 'categorize', category: cat.name }, mode: opts.makeRule, origin: 'learned', notes: `learned from txn ${txnId}` });
    rule = { id, backtest: bt };
  }
  audit(db, 'transaction', txnId, 'answer_category', undefined, { splits, makeRule: opts.makeRule }, opts.actor ?? 'user');
  return { rule };
}

/** Rules ready to be promoted to auto: enough clean confirmations and no overrides (offer, never auto-promote; D5, §15.3). */
export function promotable(db: DB, threshold = 5) {
  return db.prepare("SELECT id, notes, mode, clean_confirmations, override_count, hit_count FROM rules WHERE enabled=1 AND mode='suggest' AND clean_confirmations>=? AND override_count=0").all(threshold);
}
