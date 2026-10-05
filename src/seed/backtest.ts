import type { DB } from '../core/db.js';
import { suggestCategory } from '../core/transactions.js';
import { loadRules } from '../core/rules.js';

/**
 * Backtest the seeded rules against all migrated history (design §9.7): for every real categorized transaction, what would the rules
 * have said? Agreement validates both the seeds and the migrated data; disagreement is "drift" for you to review (e.g. a payee that changed).
 */
export interface BacktestRow { name: string; actual: string; suggested: string | null; count: number }
export interface BacktestReport { total: number; matched: number; agree: number; disagree: number; internalTransferHits: number; unmatched: number; byDisagreement: BacktestRow[]; byUnmatchedActual: { actual: string; count: number }[] }

export function backtestHistory(db: DB, opts: { limit?: number } = {}): BacktestReport {
  const rows = db.prepare(`SELECT t.descriptor_raw d, t.amount_cents a, c.name actual FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id JOIN categories c ON c.id=s.category_id
    WHERE t.legacy_group IS NULL OR t.legacy_group IS NOT NULL ORDER BY t.id ${opts.limit ? `LIMIT ${opts.limit}` : ''}`).all() as { d: string; a: number; actual: string }[];
  const rules = loadRules(db); // loaded once; read-only so a backtest never creates merchants or bumps hit counts
  const aliases = db.prepare('SELECT merchant_id, match_type, pattern, priority FROM merchant_aliases ORDER BY priority, id').all() as any[];
  const merchantsByName = new Map((db.prepare('SELECT id, name FROM merchants').all() as { id: number; name: string }[]).map((m) => [m.name.toLowerCase(), m.id]));
  const catName = new Map((db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  const dis = new Map<string, BacktestRow>(), unm = new Map<string, number>();
  let matched = 0, agree = 0, internal = 0;
  for (const r of rows) {
    const sug = suggestCategory(db, r.d, r.a, 'Legacy', undefined, { readOnly: true, rules, aliases, merchantsByName });
    if (sug.outcome === 'internal_transfer') { internal++; continue; }
    if (!sug.categoryId) { unm.set(r.actual, (unm.get(r.actual) ?? 0) + 1); continue; }
    matched++;
    const name = catName.get(sug.categoryId)!;
    if (name.toLowerCase() === r.actual.toLowerCase()) agree++;
    else { const k = `${r.actual}→${name}`; const e = dis.get(k) ?? { name: r.d, actual: r.actual, suggested: name, count: 0 }; e.count++; dis.set(k, e); }
  }
  return { total: rows.length, matched, agree, disagree: matched - agree, internalTransferHits: internal, unmatched: rows.length - matched - internal,
    byDisagreement: [...dis.values()].sort((a, b) => b.count - a.count), byUnmatchedActual: [...unm].map(([actual, count]) => ({ actual, count })).sort((a, b) => b.count - a.count) };
}
