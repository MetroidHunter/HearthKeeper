import type { DB } from './db.js';
import { INBOX_WHERE } from './reports.js';
import { incomeVsSpend, monthlySpend, monthRange } from './analytics.js';
import { getVersions, monthlyAmount } from './balance.js';
import { daysBetween } from './time.js';
import { missingAllowances } from '../greenlight/engine.js';
import { unpairedLegs } from '../ingest/pairing.js';

/** Filters the Transactions page understands for a "fix it" link from the Months checklist (same SQL as Home and Backlog, see INBOX_WHERE). */
export const NEEDS_WHERE: Record<string, string> = {
  category: INBOX_WHERE.needs_category, note: INBOX_WHERE.needs_note, stale: INBOX_WHERE.stale, flag: INBOX_WHERE.flagged,
  dupes: `EXISTS (SELECT 1 FROM transactions d WHERE d.status!='void' AND d.account_id=t.account_id AND d.occurred_on=t.occurred_on AND d.amount_cents=t.amount_cents AND d.descriptor_raw=t.descriptor_raw AND d.id!=t.id) AND t.flagged=0 AND t.kind IN ('spending','income') AND t.legacy_group IS NULL AND t.review_state!='user_confirmed'`,
};

export interface MonthItem { key: string; label: string; count: number; detail?: string; link: string }
export interface MonthStats { income: number; spent: number; net: number; planned: number; txns: number; overPlan: number; top: { name: string; cents: number } | null }
export interface MonthRow { month: string; current: boolean; items: MonthItem[]; todo: number; stats: MonthStats }

const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const COVERAGE_GRACE_DAYS = 5;
const ACTIVE_DAYS = 90; // an account with data in the last 90 days is expected to keep having it; one silent for longer is treated as closed

/**
 * One row per month from the first transaction up to today, newest first: what still needs doing in it (each with a count and a link to the
 * place that fixes it) and a few numbers about it. There is no closing step: a month is simply "nothing left to do" or not, and that can change
 * when a late file arrives.
 */
export function monthsOverview(db: DB, today: string): MonthRow[] {
  const cur = today.slice(0, 7);
  const first = (db.prepare("SELECT MIN(substr(occurred_on,1,7)) m FROM transactions WHERE status!='void'").get() as { m: string | null }).m ?? cur;
  const months = monthRange(first > cur ? cur : first, cur);
  const byMonth = (sql: string, ...args: unknown[]) => new Map((db.prepare(sql).all(...args) as { m: string; c: number }[]).map((r) => [r.m, r.c]));
  const per = (where: string) => byMonth(`SELECT substr(t.occurred_on,1,7) m, COUNT(*) c FROM transactions t WHERE t.status!='void' AND ${where} GROUP BY m`);
  const cat = per(INBOX_WHERE.needs_category), note = per(INBOX_WHERE.needs_note), stale = per(INBOX_WHERE.stale), flag = per(INBOX_WHERE.flagged);
  const txns = byMonth("SELECT substr(occurred_on,1,7) m, COUNT(*) c FROM transactions WHERE status!='void' GROUP BY m");
  const dupes = byMonth(`SELECT m, COUNT(*) c FROM (SELECT substr(occurred_on,1,7) m FROM transactions WHERE status!='void' AND flagged=0 AND kind IN ('spending','income') AND legacy_group IS NULL
    GROUP BY account_id, occurred_on, amount_cents, descriptor_raw HAVING COUNT(*)>1 AND SUM(CASE WHEN review_state='user_confirmed' THEN 1 ELSE 0 END)<COUNT(*)) GROUP BY m`);
  // transfers whose other half never showed up, and Greenlight allowances that never arrived, placed in the month they belong to
  const legIds = unpairedLegs(db); const legs = new Map<string, number>();
  if (legIds.length) for (const r of db.prepare(`SELECT substr(occurred_on,1,7) m FROM transactions WHERE id IN (${legIds.map(() => '?').join(',')})`).all(...legIds) as { m: string }[]) legs.set(r.m, (legs.get(r.m) ?? 0) + 1);
  const gl = new Map<string, number>(); for (const e of missingAllowances(db, today)) gl.set(e.expected_on.slice(0, 7), (gl.get(e.expected_on.slice(0, 7)) ?? 0) + 1);
  const pendingRequests = (db.prepare("SELECT COUNT(*) c FROM greenlight_requests WHERE status='pending'").get() as { c: number }).c;
  // data coverage per institution: does its data run through the end of the month, and is every month in between present?
  const inst = (db.prepare(`SELECT a.institution i, MIN(t.occurred_on) first, MAX(t.occurred_on) last FROM accounts a JOIN transactions t ON t.account_id=a.id AND t.status!='void'
    WHERE a.in_system=1 AND a.type IN ('credit_card','bank') GROUP BY a.institution`).all() as { i: string; first: string; last: string }[]);
  const instMonths = new Set((db.prepare(`SELECT DISTINCT a.institution || '|' || substr(t.occurred_on,1,7) k FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.status!='void'`).all() as { k: string }[]).map((r) => r.k));
  const overallLast = (db.prepare("SELECT MAX(occurred_on) d FROM transactions WHERE status!='void'").get() as { d: string | null }).d;
  const coverage = (m: string): { names: string[]; detail?: string } => {
    const end = lastDay(m), upTo = end < today ? end : today;
    // household-wide: no transactions at all through (nearly) the end of the month, whatever account they belong to
    if (!overallLast || daysBetween(overallLast, upTo) > COVERAGE_GRACE_DAYS) return { names: ['all'], detail: overallLast ? `No transactions at all after ${overallLast}. Import your bank files.` : 'No transactions yet. Import your bank files.' };
    const names = inst.filter((x) => {
    const start = `${m}-01`;
    if (x.first > end) return false; // it did not exist yet
    if (daysBetween(x.last, today) > ACTIVE_DAYS && x.last < start) return false; // dormant for a long time and already over before this month: not expected
    const endsEarly = daysBetween(x.last, upTo) > COVERAGE_GRACE_DAYS; // its data stops before this month does (an account you stopped uploading shows up here)
    const gap = x.first < start && x.last > end && !instMonths.has(`${x.i}|${m}`); // history on both sides but nothing in this month
    return endsEarly || gap;
    }).map((x) => x.i);
    return { names, detail: names.length ? `${names.join(', ')}: no data through the end of this month. Import the bank file.` : undefined };
  };
  // the numbers
  const iv = new Map(incomeVsSpend(db, months[0], cur).map((r) => [r.month, r]));
  const spend = monthlySpend(db, months[0], cur);
  const cats = db.prepare("SELECT id, start_month FROM categories WHERE kind='expense'").all() as { id: number; start_month: string }[];
  const vers = new Map(cats.map((c) => [c.id, getVersions(db, c.id)])); const startOf = new Map(cats.map((c) => [c.id, c.start_month]));
  const stats = (m: string, i: number): MonthStats => {
    const v = iv.get(m); let top: MonthStats['top'] = null, over = 0;
    for (const r of spend.rows) { const spent = r.values[i] ?? 0; if (spent > 0 && (!top || spent > top.cents)) top = { name: r.key, cents: spent };
      if (r.id !== null && startOf.has(r.id) && startOf.get(r.id)! <= m && spent > monthlyAmount(vers.get(r.id)!, m) && monthlyAmount(vers.get(r.id)!, m) > 0) over++; }
    return { income: v?.income ?? 0, spent: v?.spent ?? 0, net: (v?.income ?? 0) - (v?.spent ?? 0), planned: v?.allocated ?? 0, txns: txns.get(m) ?? 0, overPlan: over, top };
  };
  return months.map((m, i) => {
    const q = (k: string) => `month=${m}&needs=${k}`;
    const cov = coverage(m);
    const items: MonthItem[] = [
      { key: 'coverage', label: 'Data from every account', count: cov.names.length, detail: cov.detail, link: '#/imports' },
      { key: 'category', label: 'Everything categorized', count: cat.get(m) ?? 0, link: `#/transactions?${q('category')}` },
      { key: 'note', label: 'Notes in place', count: note.get(m) ?? 0, link: `#/transactions?${q('note')}` },
      { key: 'flag', label: 'Flags reviewed', count: flag.get(m) ?? 0, link: `#/transactions?${q('flag')}` },
      { key: 'stale', label: 'Pending charges resolved', count: stale.get(m) ?? 0, detail: (stale.get(m) ?? 0) ? 'Charges that never posted: hide them, or import the bank file' : undefined, link: `#/transactions?${q('stale')}` },
      { key: 'dupes', label: 'No duplicates', count: dupes.get(m) ?? 0, link: `#/transactions?${q('dupes')}` },
      { key: 'transfers', label: 'Transfers paired', count: legs.get(m) ?? 0, link: '#/transfers' },
      { key: 'greenlight', label: 'Greenlight settled', count: (gl.get(m) ?? 0) + (m === cur ? pendingRequests : 0), link: '#/greenlight' },
    ];
    return { month: m, current: m === cur, items, todo: items.filter((x) => x.count > 0).length, stats: stats(m, i) };
  }).reverse();
}
