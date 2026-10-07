import type { DB } from './db.js';
import { audit } from './db.js';
import { createRuleFor, type RuleSpec } from './merchants.js';
import { setSplits, type SplitIn } from './transactions.js';

/**
 * A user's category answer (design §9.6, §15.4). Answering also teaches the merchant history (see merchantHistory), which needs no bookkeeping here;
 * a rule is created only when the person asks for one in the same step (`rule`), with its backtest returned.
 */
export function answerCategory(db: DB, txnId: number, splits: SplitIn[], opts: { rule?: RuleSpec; flag?: { reason?: string }; actor?: string } = {}) {
  const t = db.prepare('SELECT kind FROM transactions WHERE id=?').get(txnId) as any;
  let effective = splits;
  if (t.kind === 'greenlight_reclass' && splits.length === 1 && splits[0].categoryId) {
    // A Greenlight spend has a zero total: the money is already charged to the child's category, and answering only re-attributes it.
    // "Put this in Groceries" therefore means -spend in Groceries and +spend back to the child's category, not a single $0 split.
    const charged = db.prepare('SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id=? AND amount_cents>0 ORDER BY id LIMIT 1').get(txnId) as { category_id: number | null; amount_cents: number } | undefined;
    if (charged) effective = [{ categoryId: splits[0].categoryId, amountCents: -charged.amount_cents, origin: 'greenlight_reclass' }, { categoryId: charged.category_id, amountCents: charged.amount_cents, origin: 'greenlight_reclass' }];
  }
  setSplits(db, txnId, effective, 'user');
  let rule: ReturnType<typeof createRuleFor> | undefined;
  if (opts.rule && splits.length === 1 && splits[0].categoryId) rule = createRuleFor(db, opts.rule, splits[0].categoryId, `made while categorizing transaction ${txnId}`);
  if (opts.flag) flagTransaction(db, txnId, opts.flag.reason);
  audit(db, 'transaction', txnId, 'answer_category', undefined, { splits, rule: rule?.id }, opts.actor ?? 'user');
  return { rule };
}

/** Flag a transaction for review. It stays flagged (and at the top of the Transactions list, and in Needs attention) until someone unflags it. */
export function flagTransaction(db: DB, txnId: number, reason?: string | null) {
  db.prepare('UPDATE transactions SET flagged=1, flag_reason=?, version=version+1 WHERE id=?').run(reason?.trim() ? reason.trim().slice(0, 200) : null, txnId);
}
