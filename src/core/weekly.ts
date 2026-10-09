import { DateTime } from 'luxon';
import type { DB } from './db.js';
import { audit } from './db.js';
import { lastDayOfMonth } from './reports.js';
import { monthlyAmount, getVersions } from './balance.js';

/**
 * Weekly budgets: a category's monthly budget spread over the weeks of the month, counting what is spent in that category.
 * Weeks start on `weekStart` (1 = Monday … 7 = Sunday) and are cut at month ends, so a month usually begins and ends with a short week.
 * Each week gets its share of the month by days (rounded cumulatively, so the weeks add up to the month exactly). A week that goes over eats into
 * the next one, and unspent money carries forward too, so a week's money is its share plus whatever is left from the week before.
 */
export interface Week { n: number; from: string; to: string; days: number; allottedCents: number; limitCents: number }
export interface WeekRow extends Week { carriedCents: number; availableCents: number; spentCents: number; remainingCents: number; state: 'past' | 'current' | 'future' }

const iso = (d: DateTime) => d.toISODate()!;

/** The weeks of `month` ('YYYY-MM'), each with its allotment of `amountCents` and the running limit ("threshold") by the week's end. */
export function weeksOfMonth(month: string, weekStart: number, amountCents: number): Week[] {
  const last = lastDayOfMonth(month), total = Number(last.slice(8));
  const weeks: Week[] = [];
  let from = DateTime.fromISO(`${month}-01`, { zone: 'utc' }), cum = 0, daysSoFar = 0;
  while (iso(from) <= last) {
    const toWeekEnd = (((weekStart - from.weekday + 7) % 7) || 7) - 1;            // days until the day before the next week start (0..6)
    let to = from.plus({ days: toWeekEnd });
    if (iso(to) > last) to = DateTime.fromISO(last, { zone: 'utc' });
    const days = Math.round(to.diff(from, 'days').days) + 1;
    daysSoFar += days;
    const limit = Math.round((amountCents * daysSoFar) / total);
    weeks.push({ n: weeks.length + 1, from: iso(from), to: iso(to), days, allottedCents: limit - cum, limitCents: limit });
    cum = limit;
    from = to.plus({ days: 1 });
  }
  return weeks;
}

export interface WeeklyInput { categoryId: number; weekStart?: number }

function validate(db: DB, b: WeeklyInput): Required<WeeklyInput> {
  const weekStart = b.weekStart ?? 1;
  if (!Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) throw new Error('Pick the day the week starts on');
  const c = db.prepare('SELECT kind, status FROM categories WHERE id=?').get(b.categoryId) as { kind: string; status: string } | undefined;
  if (!c || c.status !== 'active' || c.kind !== 'expense') throw new Error('Pick an active spending category');
  return { categoryId: b.categoryId, weekStart };
}
const taken = (db: DB, categoryId: number, exceptId = 0) => { if (db.prepare('SELECT 1 FROM weekly_budgets WHERE category_id=? AND id!=?').get(categoryId, exceptId)) throw new Error('That category already has a weekly budget'); };
const monthlyOf = (db: DB, categoryId: number, month: string) => monthlyAmount(getVersions(db, categoryId), month);

export function createWeekly(db: DB, input: WeeklyInput, actor = 'system', today = new Date().toISOString().slice(0, 10)): number {
  const v = validate(db, input);
  taken(db, v.categoryId);
  if (monthlyOf(db, v.categoryId, today.slice(0, 7)) <= 0) throw new Error('That category has no monthly budget to spread over the weeks. Set one on the Budget page first.');
  return db.transaction(() => {
    const sort = (db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM weekly_budgets').get() as { n: number }).n;
    const id = Number(db.prepare('INSERT INTO weekly_budgets(category_id, week_start, sort) VALUES (?,?,?)').run(v.categoryId, v.weekStart, sort).lastInsertRowid);
    audit(db, 'weekly_budget', id, 'create', undefined, v, actor);
    return id;
  })();
}

export function updateWeekly(db: DB, id: number, input: WeeklyInput, actor = 'system'): void {
  if (!db.prepare('SELECT 1 FROM weekly_budgets WHERE id=?').get(id)) throw new Error('No such weekly budget');
  const v = validate(db, input);
  taken(db, v.categoryId, id);
  db.transaction(() => {
    db.prepare('UPDATE weekly_budgets SET category_id=?, week_start=? WHERE id=?').run(v.categoryId, v.weekStart, id);
    audit(db, 'weekly_budget', id, 'update', undefined, v, actor);
  })();
}

export function deleteWeekly(db: DB, id: number, actor = 'system'): boolean {
  const n = db.prepare('DELETE FROM weekly_budgets WHERE id=?').run(id).changes > 0;
  if (n) audit(db, 'weekly_budget', id, 'delete', undefined, undefined, actor);
  return n;
}

export const setWeeklyFavorite = (db: DB, userId: number, id: number, on: boolean) => {
  if (on) db.prepare('INSERT OR IGNORE INTO weekly_favorites(user_id, weekly_id) VALUES (?,?)').run(userId, id);
  else db.prepare('DELETE FROM weekly_favorites WHERE user_id=? AND weekly_id=?').run(userId, id);
};

/** Net spending (refunds count back) in the chosen categories over [from, to]. */
function spentIn(db: DB, ids: number[], from: string, to: string): number {
  if (!ids.length) return 0;
  const q = ids.map(() => '?').join(',');
  const v = (db.prepare(`SELECT COALESCE(SUM(s.amount_cents),0) v FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
    WHERE s.category_id IN (${q}) AND t.occurred_on BETWEEN ? AND ? AND t.status!='void'`).get(...ids, from, to) as { v: number }).v;
  return v === 0 ? 0 : -v;
}

export function weeklyRows(month: string, weekStart: number, amountCents: number, spentOf: (from: string, to: string) => number, today: string): WeekRow[] {
  let remaining = 0;
  return weeksOfMonth(month, weekStart, amountCents).map((w) => {
    const carried = remaining;                                                   // what is left (or overspent) in the week before
    const availableCents = w.allottedCents + carried, spentCents = spentOf(w.from, w.to);
    remaining = availableCents - spentCents;
    return { ...w, carriedCents: carried, availableCents, spentCents, remainingCents: remaining, state: today > w.to ? 'past' : today < w.from ? 'future' : 'current' } as WeekRow;
  });
}

export interface WeeklyBudget {
  id: number; name: string; categoryId: number; category: string; amountCents: number; weekStart: number; favorite: boolean;
  month: string; weeks: WeekRow[]; spentCents: number; remainingCents: number; currentWeek: number | null;
}

/**
 * Every weekly budget, laid out for `month` (default: the month of `today`). Its total is the category's own monthly budget for that month (so it follows the
 * category when that changes) and its name is "<category> Weekly". `remainingCents` is the month's amount minus everything spent in it.
 */
export function listWeekly(db: DB, today: string, opts: { month?: string; userId?: number } = {}): WeeklyBudget[] {
  const month = opts.month ?? today.slice(0, 7);
  const favs = new Set(opts.userId ? (db.prepare('SELECT weekly_id FROM weekly_favorites WHERE user_id=?').all(opts.userId) as { weekly_id: number }[]).map((r) => r.weekly_id) : []);
  return (db.prepare('SELECT w.id, w.category_id, w.week_start, c.name category FROM weekly_budgets w JOIN categories c ON c.id=w.category_id ORDER BY w.sort, w.id').all() as any[]).map((b) => {
    const amount = monthlyOf(db, b.category_id, month);
    const weeks = weeklyRows(month, b.week_start, amount, (f, t) => spentIn(db, [b.category_id], f, t), today);
    const spent = weeks.reduce((a, w) => a + w.spentCents, 0);
    return { id: b.id, name: `${b.category} Weekly`, categoryId: b.category_id, category: b.category, amountCents: amount, weekStart: b.week_start, favorite: favs.has(b.id),
      month, weeks, spentCents: spent, remainingCents: amount - spent, currentWeek: weeks.find((w) => w.state === 'current')?.n ?? null };
  });
}
