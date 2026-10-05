import { audit, type DB } from './db.js';
import { categoryBalance } from './balance.js';
import { daysBetween } from './time.js';
import { missingAllowances, walletBalance } from '../greenlight/engine.js';
import { unpairedLegs } from '../ingest/pairing.js';

export interface CheckStep { step: number; name: string; pass: boolean; count: number; detail?: string }

/** Close checklist (design §13.4). Every step names its count so the UI can link to the offending rows. */
export function closeChecklist(db: DB, throughDate: string, opts: { walletTyped?: number; coverageToleranceDays?: number } = {}): CheckStep[] {
  const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { c: number }).c;
  const tol = opts.coverageToleranceDays ?? 5;
  const stale = (db.prepare(`SELECT a.institution i, MAX(t.occurred_on) d FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.status!='void' WHERE a.in_system=1 AND a.type IN ('credit_card','bank') GROUP BY a.institution`).all() as any[])
    .filter((r) => !r.d || daysBetween(r.d, throughDate) > tol);
  const steps: CheckStep[] = [];
  const add = (name: string, count: number, detail?: string) => steps.push({ step: steps.length + 1, name, pass: count === 0, count, detail });
  add('Coverage', stale.length, stale.map((s) => s.i).join(', '));
  add('Uncategorized', n("SELECT COUNT(*) c FROM transactions t WHERE t.status!='void' AND t.occurred_on<=? AND t.kind NOT IN ('ignored','internal_transfer') AND (t.review_state='needs_category' OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id AND s.category_id IS NULL) OR NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id))", throughDate));
  add('Provisionals', n("SELECT COUNT(*) c FROM transactions WHERE status='stale' AND occurred_on<=?", throughDate));
  add('Notes', n("SELECT COUNT(*) c FROM transactions WHERE occurred_on<=? AND note_state IN ('needs_note','ambiguous')", throughDate));
  add('Flags', n("SELECT COUNT(*) c FROM transactions WHERE occurred_on<=? AND flagged=1 AND status!='void'", throughDate));
  add('Duplicates', n(`SELECT COUNT(*) c FROM (SELECT 1 FROM transactions WHERE status!='void' AND occurred_on<=? AND flagged=0 AND kind IN ('spending','income') AND legacy_group IS NULL GROUP BY account_id, occurred_on, amount_cents, descriptor_raw HAVING COUNT(*)>1 AND SUM(CASE WHEN review_state='user_confirmed' THEN 1 ELSE 0 END)<COUNT(*))`, throughDate));
  const wallet = db.prepare("SELECT id FROM accounts WHERE type='greenlight_wallet' LIMIT 1").get() as { id: number } | undefined;
  const gl = n("SELECT COUNT(*) c FROM greenlight_requests WHERE status='pending'") + missingAllowances(db, throughDate).length
    + (opts.walletTyped !== undefined && wallet && walletBalance(db, wallet.id) !== opts.walletTyped ? 1 : 0);
  add('Greenlight', gl);
  add('Unrecognized', n("SELECT COUNT(*) c FROM raw_events WHERE parse_status IN ('unrecognized','error')") + unpairedLegs(db).length);
  const month = throughDate;
  const overs = (db.prepare("SELECT id FROM categories WHERE kind='expense' AND status='active'").all() as any[]).filter((c) => (categoryBalance(db, c.id, month).total ?? 0) < -0.5).length;
  add('Overages', overs);
  const pool = (db.prepare("SELECT id FROM categories WHERE kind='income_pool'").all() as any[]).filter((c) => Math.abs(categoryBalance(db, c.id, month).total ?? 0) > 0.5).length;
  add('Pool', pool);
  steps.push({ step: steps.length + 1, name: 'Review', pass: true, count: 0, detail: 'manual scan of biggest and newest transactions' });
  return steps;
}

/** Snapshot balances and soft-lock edits through a date (see locks.ts for enforcement and reopen). */
export function closePeriod(db: DB, throughDate: string, actor: string): number {
  const snap: Record<number, number | null> = {};
  for (const c of db.prepare('SELECT id FROM categories').all() as any[]) snap[c.id] = categoryBalance(db, c.id, throughDate).total;
  const id = Number(db.prepare('INSERT INTO close_periods(through_date, closed_by, snapshot_json) VALUES (?,?,?)').run(throughDate, actor, JSON.stringify(snap)).lastInsertRowid);
  audit(db, 'close_period', id, 'close', undefined, { throughDate }, actor);
  return id;
}
export { lockedThrough, assertOpen } from './locks.js';
