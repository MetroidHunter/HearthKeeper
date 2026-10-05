import { audit, type DB } from './db.js';
import { monthOf } from './time.js';
import { categoryBalance } from './balance.js';
import { isOpenMonth } from './locks.js';
import { PeriodClosedError, lockedThrough } from './locks.js';

export function ensureGroup(db: DB, name: string): number {
  const r = db.prepare('SELECT id FROM category_groups WHERE name=?').get(name) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO category_groups(name) VALUES (?)').run(name).lastInsertRowid);
}

export interface NewCategory { name: string; group?: string; kind?: 'expense' | 'income_pool' | 'income_reference'; discretionary?: boolean; cushionCents?: number | null; startMonth: string; monthlyCents?: number; overagePriority?: number | null }

/** Add a category; start month is required (prevents the historicalBudget missing-Start-Date throw, §12.1). */
export function addCategory(db: DB, c: NewCategory, actor = 'system'): number {
  if (!/^\d{4}-\d{2}$/.test(c.startMonth)) throw new Error('startMonth (YYYY-MM) is required');
  return db.transaction(() => {
    const gid = c.group ? ensureGroup(db, c.group) : null;
    const id = Number(db.prepare(`INSERT INTO categories(group_id,name,kind,discretionary,cushion_cents,overage_priority,start_month) VALUES (?,?,?,?,?,?,?)`)
      .run(gid, c.name, c.kind ?? 'expense', c.discretionary === false ? 0 : 1, c.cushionCents ?? null, c.overagePriority ?? null, c.startMonth).lastInsertRowid);
    if (c.monthlyCents !== undefined) setBudget(db, id, c.monthlyCents, c.startMonth, { reason: 'initial', actor });
    audit(db, 'category', id, 'create', undefined, c, actor);
    return id;
  })();
}

/** Append (or replace within the same month) a budget version: the quick path of design §12.2. */
export function setBudget(db: DB, categoryId: number, monthlyCents: number, effectiveMonth: string, opts: { reason?: string; planId?: number; actor?: string } = {}): void {
  if (opts.actor !== 'migration' && opts.reason !== 'legacy' && !isOpenMonth(db, effectiveMonth)) throw new PeriodClosedError(lockedThrough(db)!); // a budget change restates a closed month
  const prev = db.prepare('SELECT monthly_cents FROM category_budget_versions WHERE category_id=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 1').get(categoryId, effectiveMonth) as { monthly_cents: number } | undefined;
  db.prepare(`INSERT INTO category_budget_versions(category_id,monthly_cents,effective_month,plan_id,reason,created_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(category_id, effective_month) DO UPDATE SET monthly_cents=excluded.monthly_cents, plan_id=excluded.plan_id, reason=excluded.reason, created_by=excluded.created_by`)
    .run(categoryId, monthlyCents, effectiveMonth, opts.planId ?? null, opts.reason ?? null, opts.actor ?? 'system');
  audit(db, 'budget_version', categoryId, 'set', { monthly_cents: prev?.monthly_cents ?? null }, { monthly_cents: monthlyCents, effective_month: effectiveMonth }, opts.actor);
}

export interface BudgetHistoryEntry { effective_month: string; monthly_cents: number; from_cents: number | null; plan_id: number | null; reason: string | null; created_by: string | null }
export function budgetHistory(db: DB, categoryId: number): BudgetHistoryEntry[] {
  const rows = db.prepare('SELECT effective_month, monthly_cents, plan_id, reason, created_by FROM category_budget_versions WHERE category_id=? ORDER BY effective_month').all(categoryId) as any[];
  return rows.map((r, i) => ({ ...r, from_cents: i === 0 ? null : rows[i - 1].monthly_cents }));
}

/** Retire: sets status, appends a 0 version, preserves transactions; optionally moves remaining balance (§12.1). */
export function retireCategory(db: DB, categoryId: number, month: string, opts: { moveBalanceTo?: number; asOf?: string; actor?: string } = {}): { remainingCents: number } {
  return db.transaction(() => {
    setBudget(db, categoryId, 0, month, { reason: 'retired', actor: opts.actor });
    db.prepare("UPDATE categories SET status='retired', retired_month=?, version=version+1 WHERE id=?").run(month, categoryId);
    const endOfMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
    const asOf = opts.asOf ?? endOfMonth;
    const bal = categoryBalance(db, categoryId, asOf).total ?? 0;
    if (opts.moveBalanceTo && bal !== 0) {
      const t = Number(db.prepare("INSERT INTO envelope_transfers(occurred_on, kind, memo, created_by) VALUES (?, 'manual', 'retire: move remaining balance', ?)").run(asOf, opts.actor ?? 'system').lastInsertRowid);
      db.prepare('INSERT INTO envelope_transfer_legs(transfer_id, category_id, amount_cents) VALUES (?,?,?)').run(t, categoryId, -bal);
      db.prepare('INSERT INTO envelope_transfer_legs(transfer_id, category_id, amount_cents) VALUES (?,?,?)').run(t, opts.moveBalanceTo, bal);
    }
    audit(db, 'category', categoryId, 'retire', undefined, { month }, opts.actor);
    return { remainingCents: bal };
  })();
}
/** Undo a retirement. The category comes back with `monthlyCents` (default: the last non-zero amount it had) effective `month`. Months while it was retired stay at zero. */
export function unretireCategory(db: DB, categoryId: number, month: string, opts: { monthlyCents?: number; actor?: string } = {}): { monthlyCents: number } {
  return db.transaction(() => {
    const c = db.prepare('SELECT name, status FROM categories WHERE id=?').get(categoryId) as { name: string; status: string } | undefined;
    if (!c) throw new Error('unknown category');
    if (c.status !== 'retired') throw new Error('category is not retired');
    if (c.name.toLowerCase() === 'needs category') throw new Error('NEEDS CATEGORY is represented by the uncategorized state and cannot be reactivated');
    const last = db.prepare('SELECT monthly_cents FROM category_budget_versions WHERE category_id=? AND monthly_cents>0 ORDER BY effective_month DESC LIMIT 1').get(categoryId) as { monthly_cents: number } | undefined;
    const monthlyCents = opts.monthlyCents ?? last?.monthly_cents ?? 0;
    db.prepare("UPDATE categories SET status='active', retired_month=NULL, version=version+1 WHERE id=?").run(categoryId);
    setBudget(db, categoryId, monthlyCents, month, { reason: 'unretired', actor: opts.actor });
    audit(db, 'category', categoryId, 'unretire', undefined, { month, monthlyCents }, opts.actor);
    return { monthlyCents };
  })();
}
export { monthOf };
