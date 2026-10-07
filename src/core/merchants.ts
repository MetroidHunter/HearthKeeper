import type { DB } from './db.js';
import { addRule, backtest, validateMatch, type RuleMatch } from './rules.js';

/**
 * What you have chosen for a merchant, most often first. This IS the "merchant rule": nothing is stored or promoted, so it can never get stale,
 * and a one-off exception only moves the count by one. It only ever suggests; rules you make yourself always outrank it.
 * Only your own answers count (and the history imported from your sheet), never what a rule did on its own.
 */
export function merchantHistory(db: DB, merchantId: number, limit = 5): { categoryId: number; name: string; n: number }[] {
  return db.prepare(`SELECT c.id categoryId, c.name, COUNT(DISTINCT t.id) n FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id JOIN categories c ON c.id=s.category_id
    WHERE t.merchant_id=? AND t.status!='void' AND t.kind NOT IN ('ignored','internal_transfer') AND s.origin IN ('user','legacy') AND c.system=0 AND c.status='active'
    GROUP BY c.id ORDER BY n DESC, c.name LIMIT ?`).all(merchantId, limit) as { categoryId: number; name: string; n: number }[];
}

export interface RuleSpec { match: RuleMatch; mode?: 'auto' | 'suggest'; priority?: number }
/** A rule you made while categorizing. It is always yours (origin 'user'), and its backtest is returned so the result can be shown. */
export function createRuleFor(db: DB, spec: RuleSpec, categoryId: number, note: string) {
  const cat = db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) as { name: string } | undefined;
  if (!cat) throw new Error('unknown category');
  validateMatch(spec.match);
  const priority = spec.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9999) throw new Error('priority must be a whole number from 1 to 9999');
  const bt = backtest(db, { match: spec.match });
  const id = addRule(db, { match: spec.match, action: { type: 'categorize', category: cat.name }, mode: spec.mode === 'auto' ? 'auto' : 'suggest', priority, origin: 'user', notes: note });
  return { id, backtest: bt };
}
