import { audit, type DB } from './db.js';
import { monthOf } from './time.js';
import { accrued, categoryBalance, getVersions } from './balance.js';

export function ensureGroup(db: DB, name: string): number {
  const r = db.prepare('SELECT id FROM category_groups WHERE name=?').get(name) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO category_groups(name) VALUES (?)').run(name).lastInsertRowid);
}

export interface NewCategory { name: string; group?: string; kind?: 'expense' | 'income_pool' | 'income_reference'; discretionary?: boolean; cushionCents?: number | null; startMonth: string; monthlyCents?: number; overagePriority?: number | null }

/** Add a category; start month is required (prevents the historicalBudget missing-Start-Date throw, §12.1). */
export function addCategory(db: DB, c: NewCategory, actor = 'system'): number {
  if (!/^\d{4}-\d{2}$/.test(c.startMonth)) throw new Error('startMonth (YYYY-MM) is required');
  c = { ...c, name: String(c.name ?? '').trim() };
  if (!c.name) throw new Error('A category name is required');
  const clash = db.prepare('SELECT name, status FROM categories WHERE name=? COLLATE NOCASE').get(c.name) as { name: string; status: string } | undefined;
  if (clash) throw new Error(clash.status === 'retired' ? `A category named "${clash.name}" already exists, and it is retired. Unretire it from the Categories list instead of adding it again.` : `A category named "${clash.name}" already exists. Pick a different name.`);
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

/** The rules that file into a category, on or off (a rule names its category as text, so it is matched by name). */
export function rulesForCategory(db: DB, categoryId: number): { id: number; enabled: number; [k: string]: unknown }[] {
  const name = (db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) as { name: string } | undefined)?.name.toLowerCase();
  if (!name) return [];
  return (db.prepare("SELECT * FROM rules ORDER BY priority, id").all() as any[]).filter((r) => {
    try { const a = JSON.parse(r.action_json); return a?.type === 'categorize' && String(a.category ?? '').toLowerCase() === name; } catch { return false; }
  });
}
const setRules = (db: DB, categoryId: number, enabled: 0 | 1): number => {
  const ids = rulesForCategory(db, categoryId).filter((r) => r.enabled !== enabled).map((r) => r.id);
  for (const id of ids) db.prepare('UPDATE rules SET enabled=? WHERE id=?').run(enabled, id);
  return ids.length;
};

const endOfMonth = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);

/**
 * What retiring in `month` leaves in the envelope. Retiring sets the monthly amount to zero from that month on, so that month's accrual
 * stops too: `afterCents` is the balance at the end of `month` without it, which is what a "move the balance" transfer moves.
 * An envelope that is overspent now, or would be once the accrual stops, cannot retire.
 */
export function retirePreview(db: DB, categoryId: number, month: string, o: { asOf?: string; today?: string } = {}) {
  const cat = db.prepare('SELECT name, start_month FROM categories WHERE id=?').get(categoryId) as { name: string; start_month: string };
  const asOf = o.asOf ?? endOfMonth(month);
  const now = categoryBalance(db, categoryId, o.today ?? o.asOf ?? new Date().toISOString().slice(0, 10)).total ?? 0;
  const parts = categoryBalance(db, categoryId, asOf);
  const versions = [...getVersions(db, categoryId).filter((v) => v.effective_month < month), { effective_month: month, monthly_cents: 0 }];
  const after = parts.total === null ? 0 : parts.splits + parts.transfers + accrued(cat.start_month, versions, asOf);
  const reason = now < 0 ? `${cat.name} is overspent by ${cents(-now)}. Move money into it (or categorize the spending elsewhere) until it is at $0 or more, then retire it.`
    : after < 0 ? `Retiring stops this month's budget, which would leave ${cat.name} overspent by ${cents(-after)}. Move at least that much into it first, then retire it.` : null;
  return { currentCents: now, afterCents: after, canRetire: reason === null, reason, rules: rulesForCategory(db, categoryId) };
}
const cents = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Retire: sets status, appends a 0 version, preserves transactions; optionally moves remaining balance and turns off the rules that file into it (§12.1). An overspent envelope cannot retire. */
export function retireCategory(db: DB, categoryId: number, month: string, opts: { moveBalanceTo?: number; asOf?: string; actor?: string; disableRules?: boolean; today?: string } = {}): { remainingCents: number; rulesDisabled: number } {
  return db.transaction(() => {
    const p = retirePreview(db, categoryId, month, { asOf: opts.asOf, today: opts.today });
    if (!p.canRetire) throw new Error(`Cannot retire: ${p.reason}`);
    setBudget(db, categoryId, 0, month, { reason: 'retired', actor: opts.actor });
    db.prepare("UPDATE categories SET status='retired', retired_month=?, version=version+1 WHERE id=?").run(month, categoryId);
    const asOf = opts.asOf ?? endOfMonth(month);
    const bal = categoryBalance(db, categoryId, asOf).total ?? 0;
    if (opts.moveBalanceTo && bal !== 0) {
      const on = opts.today && opts.today < asOf ? opts.today : asOf; // retiring this month: the money lands today, not at month end, so it shows in the destination now
      const t = Number(db.prepare("INSERT INTO envelope_transfers(occurred_on, kind, memo, created_by) VALUES (?, 'manual', 'retire: move remaining balance', ?)").run(on, opts.actor ?? 'system').lastInsertRowid);
      db.prepare('INSERT INTO envelope_transfer_legs(transfer_id, category_id, amount_cents) VALUES (?,?,?)').run(t, categoryId, -bal);
      db.prepare('INSERT INTO envelope_transfer_legs(transfer_id, category_id, amount_cents) VALUES (?,?,?)').run(t, opts.moveBalanceTo, bal);
    }
    const rulesDisabled = opts.disableRules ? setRules(db, categoryId, 0) : 0;
    audit(db, 'category', categoryId, 'retire', undefined, { month, rulesDisabled }, opts.actor);
    return { remainingCents: bal, rulesDisabled };
  })();
}
/** Undo a retirement. The category comes back with `monthlyCents` (default: the last non-zero amount it had) effective `month`, and `enableRules` turns its rules back on. Months while it was retired stay at zero. */
export function unretireCategory(db: DB, categoryId: number, month: string, opts: { monthlyCents?: number; actor?: string; enableRules?: boolean } = {}): { monthlyCents: number; rulesEnabled: number } {
  return db.transaction(() => {
    const c = db.prepare('SELECT name, status, system FROM categories WHERE id=?').get(categoryId) as { name: string; status: string; system: number } | undefined;
    if (!c) throw new Error('unknown category');
    if (c.status !== 'retired') throw new Error('category is not retired');
    if (c.system) throw new Error('This is a reserved category for imported history');
    if (c.name.toLowerCase() === 'needs category') throw new Error('NEEDS CATEGORY is represented by the uncategorized state and cannot be reactivated');
    const last = db.prepare('SELECT monthly_cents FROM category_budget_versions WHERE category_id=? AND monthly_cents>0 ORDER BY effective_month DESC LIMIT 1').get(categoryId) as { monthly_cents: number } | undefined;
    const monthlyCents = opts.monthlyCents ?? last?.monthly_cents ?? 0;
    db.prepare("UPDATE categories SET status='active', retired_month=NULL, version=version+1 WHERE id=?").run(categoryId);
    setBudget(db, categoryId, monthlyCents, month, { reason: 'unretired', actor: opts.actor });
    const rulesEnabled = opts.enableRules ? setRules(db, categoryId, 1) : 0;
    audit(db, 'category', categoryId, 'unretire', undefined, { month, monthlyCents, rulesEnabled }, opts.actor);
    return { monthlyCents, rulesEnabled };
  })();
}
export { monthOf };
