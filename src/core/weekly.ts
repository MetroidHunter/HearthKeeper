import { DateTime } from 'luxon';
import type { DB } from './db.js';
import { audit } from './db.js';
import { lastDayOfMonth } from './reports.js';

/**
 * Weekly budgets: one monthly amount spread over the weeks of the month, counting what is spent in the chosen categories.
 * Weeks start on `weekStart` (1 = Monday … 7 = Sunday) and are cut at month ends, so a month usually begins and ends with a short week.
 * Each week gets its share of the month by days (rounded cumulatively, so the weeks add up to the month exactly). A week that goes over eats into
 * the next one; with `rollover` on, unspent money carries forward too.
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

export interface WeeklyInput { name: string; amountCents: number; categoryIds: number[]; weekStart?: number; rollover?: boolean }

function validate(db: DB, b: WeeklyInput): Required<WeeklyInput> {
  const name = String(b.name ?? '').trim();
  if (!name) throw new Error('Give the weekly budget a name');
  if (!Number.isInteger(b.amountCents) || b.amountCents <= 0) throw new Error('The monthly amount must be more than zero');
  const weekStart = b.weekStart ?? 1;
  if (!Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) throw new Error('Pick the day the week starts on');
  const ids = [...new Set((b.categoryIds ?? []).map(Number))];
  if (!ids.length) throw new Error('Pick at least one category whose spending counts');
  for (const id of ids) {
    const c = db.prepare('SELECT kind, status FROM categories WHERE id=?').get(id) as { kind: string; status: string } | undefined;
    if (!c || c.status !== 'active' || c.kind !== 'expense') throw new Error('Only active spending categories can be part of a weekly budget');
  }
  return { name, amountCents: b.amountCents, categoryIds: ids, weekStart, rollover: !!b.rollover };
}

function setCategories(db: DB, id: number, ids: number[]) {
  db.prepare('DELETE FROM weekly_budget_categories WHERE weekly_id=?').run(id);
  for (const c of ids) db.prepare('INSERT INTO weekly_budget_categories(weekly_id, category_id) VALUES (?,?)').run(id, c);
}

export function createWeekly(db: DB, input: WeeklyInput, actor = 'system'): number {
  const v = validate(db, input);
  return db.transaction(() => {
    const sort = (db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM weekly_budgets').get() as { n: number }).n;
    const id = Number(db.prepare('INSERT INTO weekly_budgets(name, amount_cents, week_start, rollover, sort) VALUES (?,?,?,?,?)').run(v.name, v.amountCents, v.weekStart, v.rollover ? 1 : 0, sort).lastInsertRowid);
    setCategories(db, id, v.categoryIds);
    audit(db, 'weekly_budget', id, 'create', undefined, v, actor);
    return id;
  })();
}

export function updateWeekly(db: DB, id: number, input: WeeklyInput, actor = 'system'): void {
  if (!db.prepare('SELECT 1 FROM weekly_budgets WHERE id=?').get(id)) throw new Error('No such weekly budget');
  const v = validate(db, input);
  db.transaction(() => {
    db.prepare('UPDATE weekly_budgets SET name=?, amount_cents=?, week_start=?, rollover=? WHERE id=?').run(v.name, v.amountCents, v.weekStart, v.rollover ? 1 : 0, id);
    setCategories(db, id, v.categoryIds);
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

export function weeklyRows(month: string, weekStart: number, amountCents: number, rollover: boolean, spentOf: (from: string, to: string) => number, today: string): WeekRow[] {
  let remaining = 0, first = true;
  return weeksOfMonth(month, weekStart, amountCents).map((w) => {
    const carried = first ? 0 : rollover ? remaining : Math.min(0, remaining);   // an overspent week always carries; unspent money only with rollover
    first = false;
    const availableCents = w.allottedCents + carried, spentCents = spentOf(w.from, w.to);
    remaining = availableCents - spentCents;
    return { ...w, carriedCents: carried, availableCents, spentCents, remainingCents: remaining, state: today > w.to ? 'past' : today < w.from ? 'future' : 'current' } as WeekRow;
  });
}

export interface WeeklyBudget {
  id: number; name: string; amountCents: number; weekStart: number; rollover: boolean; categoryIds: number[]; categories: string[]; favorite: boolean;
  month: string; weeks: WeekRow[]; spentCents: number; remainingCents: number; currentWeek: number | null;
}

/** Every weekly budget, laid out for `month` (default: the month of `today`). `remainingCents` is the month's amount minus everything spent in it. */
export function listWeekly(db: DB, today: string, opts: { month?: string; userId?: number } = {}): WeeklyBudget[] {
  const month = opts.month ?? today.slice(0, 7);
  const favs = new Set(opts.userId ? (db.prepare('SELECT weekly_id FROM weekly_favorites WHERE user_id=?').all(opts.userId) as { weekly_id: number }[]).map((r) => r.weekly_id) : []);
  return (db.prepare('SELECT id, name, amount_cents, week_start, rollover FROM weekly_budgets ORDER BY sort, id').all() as any[]).map((b) => {
    const cats = db.prepare('SELECT c.id, c.name FROM weekly_budget_categories w JOIN categories c ON c.id=w.category_id WHERE w.weekly_id=? ORDER BY c.name').all(b.id) as { id: number; name: string }[];
    const ids = cats.map((c) => c.id);
    const weeks = weeklyRows(month, b.week_start, b.amount_cents, !!b.rollover, (f, t) => spentIn(db, ids, f, t), today);
    const spent = weeks.reduce((a, w) => a + w.spentCents, 0);
    return { id: b.id, name: b.name, amountCents: b.amount_cents, weekStart: b.week_start, rollover: !!b.rollover, categoryIds: ids, categories: cats.map((c) => c.name), favorite: favs.has(b.id),
      month, weeks, spentCents: spent, remainingCents: b.amount_cents - spent, currentWeek: weeks.find((w) => w.state === 'current')?.n ?? null };
  });
}
