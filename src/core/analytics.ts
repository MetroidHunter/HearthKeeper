import type { DB } from './db.js';
import { categoryBalance, getVersions, monthlyAmount } from './balance.js';
import { addMonths, monthIndex } from './time.js';

/** Plain-SQL aggregates behind the chart catalog (design §14.2). Spent is net outflow, so refunds reduce it (D13); transfers and accruals never appear. */
const SPEND_KINDS = "('spending','income','greenlight_allowance','greenlight_return','greenlight_reclass')";

export function monthRange(from: string, to: string): string[] {
  const out: string[] = []; for (let m = from; monthIndex(m) <= monthIndex(to); m = addMonths(m, 1)) out.push(m); return out;
}
const firstDay = (m: string) => `${m}-01`;
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

export interface Matrix { months: string[]; rows: { key: string; group: string | null; id: number | null; values: number[]; total: number }[] }

/** Spent by month for every expense category (or group). Backbone of the stacked bars, heatmap, treemap and year pivot. */
export function monthlySpend(db: DB, fromMonth: string, toMonth: string, by: 'category' | 'group' = 'category'): Matrix {
  const months = monthRange(fromMonth, toMonth);
  const rows = db.prepare(`SELECT substr(t.occurred_on,1,7) m, c.id id, c.name name, COALESCE(g.name,'Ungrouped') grp, SUM(s.amount_cents) net
    FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id JOIN categories c ON c.id=s.category_id LEFT JOIN category_groups g ON g.id=c.group_id
    WHERE t.status!='void' AND t.kind IN ${SPEND_KINDS} AND c.kind='expense' AND t.occurred_on BETWEEN ? AND ? GROUP BY m, c.id`).all(firstDay(fromMonth), lastDay(toMonth)) as any[];
  const acc = new Map<string, Matrix['rows'][number]>();
  for (const r of rows) {
    const key = by === 'group' ? r.grp : r.name;
    const e = acc.get(key) ?? { key, group: by === 'group' ? null : r.grp, id: by === 'group' ? null : r.id, values: months.map(() => 0), total: 0 };
    const i = months.indexOf(r.m); if (i >= 0) { e.values[i] += 0 - r.net; e.total += 0 - r.net; }
    acc.set(key, e);
  }
  return { months, rows: [...acc.values()].sort((a, b) => b.total - a.total) };
}

export interface TrendPoint { month: string; spent: number; trailingAvg: number; budget: number; balance: number | null }
/** Category trend with trailing average, the budget line, and the envelope balance at each month end (design §14.2). */
export function categoryTrend(db: DB, categoryId: number, fromMonth: string, toMonth: string, window = 3): TrendPoint[] {
  const months = monthRange(fromMonth, toMonth);
  const versions = getVersions(db, categoryId);
  const spent = new Map((db.prepare(`SELECT substr(t.occurred_on,1,7) m, SUM(s.amount_cents) net FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
    WHERE s.category_id=? AND t.status!='void' AND t.kind IN ${SPEND_KINDS} AND t.occurred_on BETWEEN ? AND ? GROUP BY m`).all(categoryId, firstDay(fromMonth), lastDay(toMonth)) as any[]).map((r) => [r.m, -r.net]));
  const pts: TrendPoint[] = months.map((month) => ({ month, spent: spent.get(month) ?? 0, trailingAvg: 0, budget: monthlyAmount(versions, month), balance: categoryBalance(db, categoryId, lastDay(month)).total }));
  pts.forEach((p, i) => { const w = pts.slice(Math.max(0, i - window + 1), i + 1); p.trailingAvg = w.reduce((a, x) => a + x.spent, 0) / w.length; });
  return pts;
}

export interface IncomeVsSpend { month: string; income: number; spent: number; allocated: number }
/** Is the plan funded? Income received vs. net spend vs. what was allocated that month. */
export function incomeVsSpend(db: DB, fromMonth: string, toMonth: string): IncomeVsSpend[] {
  const months = monthRange(fromMonth, toMonth);
  const inc = new Map<string, number>(), sp = new Map<string, number>();
  for (const r of db.prepare(`SELECT substr(t.occurred_on,1,7) m, c.kind kind, SUM(s.amount_cents) net FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id JOIN categories c ON c.id=s.category_id
    WHERE t.status!='void' AND t.kind IN ${SPEND_KINDS} AND t.occurred_on BETWEEN ? AND ? GROUP BY m, c.kind`).all(firstDay(fromMonth), lastDay(toMonth)) as any[]) {
    if (r.kind === 'expense') sp.set(r.m, (sp.get(r.m) ?? 0) - r.net); else inc.set(r.m, (inc.get(r.m) ?? 0) + r.net);
  }
  const cats = db.prepare("SELECT id, start_month FROM categories WHERE kind='expense'").all() as { id: number; start_month: string }[];
  const vers = new Map(cats.map((c) => [c.id, getVersions(db, c.id)]));
  return months.map((month) => ({ month, income: inc.get(month) ?? 0, spent: sp.get(month) ?? 0,
    allocated: cats.reduce((a, c) => a + (c.start_month <= month ? monthlyAmount(vers.get(c.id)!, month) : 0), 0) }));
}

export interface TreemapNode { name: string; value: number; children?: TreemapNode[] }
/** Group > category blocks for a period (spend-weighted). */
export function treemap(db: DB, fromMonth: string, toMonth: string): TreemapNode[] {
  const m = monthlySpend(db, fromMonth, toMonth, 'category');
  const groups = new Map<string, TreemapNode>();
  for (const r of m.rows) {
    if (r.total <= 0) continue;
    const g = groups.get(r.group ?? 'Ungrouped') ?? { name: r.group ?? 'Ungrouped', value: 0, children: [] };
    g.value += r.total; g.children!.push({ name: r.key, value: r.total }); groups.set(g.name, g);
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

/** Category x year spent (replaces the `Year` sheet). */
export function yearPivot(db: DB, fromYear: number, toYear: number) {
  const m = monthlySpend(db, `${fromYear}-01`, `${toYear}-12`, 'category');
  const years = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
  return { years, rows: m.rows.map((r) => ({ key: r.key, group: r.group, values: years.map((y) => r.values.reduce((a, v, i) => a + (m.months[i].startsWith(String(y)) ? v : 0), 0)), total: r.total })) };
}

/** Budget vs actual for one month: the bullet-bar data. */
export function budgetVsActual(db: DB, month: string) {
  const spent = new Map(monthlySpend(db, month, month).rows.map((r) => [r.id, r.total]));
  return (db.prepare("SELECT c.id, c.name, COALESCE(g.name,'Ungrouped') grp FROM categories c LEFT JOIN category_groups g ON g.id=c.group_id WHERE c.kind='expense' AND c.status='active'").all() as any[])
    .map((c) => ({ id: c.id, name: c.name, group: c.grp, budget: monthlyAmount(getVersions(db, c.id), month), spent: spent.get(c.id) ?? 0 }))
    .filter((r) => r.budget > 0 || r.spent !== 0).sort((a, b) => b.budget - a.budget);
}
