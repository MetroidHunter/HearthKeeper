import type { DB } from './db.js';
import { categoryBalance, currentAllocation, periodTotals } from './balance.js';
import { monthOf } from './time.js';

export interface BudgetRow { id: number; group: string | null; name: string; kind: string; targetCents: number; currentCents: number | null; spent: [number, number]; gained: [number, number]; net: [number, number]; favorite?: boolean }
export interface Period { from: string; to: string }

export function lastDayOfMonth(m: string): string { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; }
export function monthPeriod(m: string): Period { return { from: `${m}-01`, to: lastDayOfMonth(m) }; }
export function prevMonthKey(m: string): string { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }

/** The Budget page (design §12.3): same columns as the sheet, for any two periods. */
export function budgetPage(db: DB, today: string, periods?: [Period, Period], userId?: number) {
  const m = monthOf(today);
  const [a, b] = periods ?? [monthPeriod(m), monthPeriod(prevMonthKey(m))];
  const alloc = currentAllocation(db, m);
  const favs = new Set(userId ? (db.prepare('SELECT category_id FROM favorites WHERE user_id=?').all(userId) as any[]).map((r) => r.category_id) : []);
  const cats = db.prepare("SELECT c.id, g.name grp, c.name, c.kind FROM categories c LEFT JOIN category_groups g ON g.id=c.group_id WHERE c.status='active' ORDER BY g.sort, g.name, c.sort, c.name").all() as any[];
  const rows: BudgetRow[] = cats.map((c) => {
    const pa = periodTotals(db, c.id, a.from, a.to), pb = periodTotals(db, c.id, b.from, b.to);
    return { id: c.id, group: c.grp, name: c.name, kind: c.kind, targetCents: alloc.byCategory[c.id] ?? 0, currentCents: categoryBalance(db, c.id, today).total,
      spent: [pa.spent, pb.spent], gained: [pa.gained, pb.gained], net: [pa.gained - pa.spent, pb.gained - pb.spent], favorite: favs.has(c.id) };
  });
  const live = db.prepare("SELECT id, name, income_snapshot_cents FROM budget_plans WHERE status='live'").get() as any;
  const income = live?.income_snapshot_cents ?? 0;
  return { periods: [a, b], rows, header: { livePlan: live?.name ?? null, incomeCents: income, allocatedCents: alloc.allocated, unallocatedCents: income - alloc.allocated } };
}

/** Budget percentage pie (D18, D25): share of allocation or of spend, by group with category drill-down. */
export function budgetPie(db: DB, today: string, mode: 'allocated' | 'spent' = 'allocated', period?: Period) {
  const m = monthOf(today);
  const p = period ?? monthPeriod(m);
  const alloc = currentAllocation(db, m);
  const cats = db.prepare("SELECT c.id, COALESCE(g.name,'Ungrouped') grp, c.name FROM categories c LEFT JOIN category_groups g ON g.id=c.group_id WHERE c.status='active' AND c.kind='expense'").all() as any[];
  const groups = new Map<string, { name: string; cents: number; categories: { id: number; name: string; cents: number }[] }>();
  for (const c of cats) {
    const v = mode === 'allocated' ? alloc.byCategory[c.id] ?? 0 : Math.max(0, periodTotals(db, c.id, p.from, p.to).spent);
    if (v <= 0) continue;
    const g = groups.get(c.grp) ?? groups.set(c.grp, { name: c.grp, cents: 0, categories: [] }).get(c.grp)!;
    g.cents += v; g.categories.push({ id: c.id, name: c.name, cents: v });
  }
  const total = [...groups.values()].reduce((a, g) => a + g.cents, 0);
  return { mode, totalCents: total, groups: [...groups.values()].sort((a, b) => b.cents - a.cents).map((g) => ({ ...g, share: total ? g.cents / total : 0, categories: g.categories.sort((a, b) => b.cents - a.cents) })) };
}

/** Spend by merchant / merchant group / category over any range (design §14). */
export function spendBy(db: DB, dim: 'category' | 'merchant' | 'merchant_group' | 'month' | 'account', p: Period) {
  const base = `FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id LEFT JOIN categories c ON c.id=s.category_id LEFT JOIN merchants m ON m.id=t.merchant_id JOIN accounts a ON a.id=t.account_id
    WHERE t.occurred_on BETWEEN ? AND ? AND t.status!='void' AND t.kind IN ('spending','income','greenlight_allowance','greenlight_return','greenlight_reclass') AND (c.kind='expense' OR c.kind IS NULL)`;
  const sel = { category: "COALESCE(c.name,'(needs category)')", merchant: "COALESCE(m.name,'(none)')", month: "substr(t.occurred_on,1,7)", account: 'a.name',
    merchant_group: "COALESCE((SELECT g.name FROM merchant_group_members gm JOIN merchant_groups g ON g.id=gm.group_id WHERE gm.merchant_id=m.id LIMIT 1), COALESCE(m.name,'(none)'))" }[dim];
  return db.prepare(`SELECT ${sel} key, -SUM(s.amount_cents) spent, COUNT(DISTINCT t.id) count ${base} GROUP BY key ORDER BY spent DESC`).all(p.from, p.to) as { key: string; spent: number; count: number }[];
}

/** Explore (§14.3): free-text over descriptor, note, item names, merchant; returns total, monthly average, count and sparkline. */
export function explore(db: DB, q: string, p: Period) {
  const like = `%${q.toLowerCase()}%`;
  const rows = db.prepare(`SELECT t.id, t.occurred_on d, -SUM(s.amount_cents) v FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id LEFT JOIN merchants m ON m.id=t.merchant_id
    WHERE t.occurred_on BETWEEN ? AND ? AND t.status!='void' AND (LOWER(t.descriptor_raw) LIKE ? OR LOWER(COALESCE(t.note,'')) LIKE ? OR LOWER(COALESCE(m.name,'')) LIKE ?
      OR EXISTS (SELECT 1 FROM merchant_group_members gm JOIN merchant_groups g ON g.id=gm.group_id WHERE gm.merchant_id=m.id AND LOWER(g.name) LIKE ?)
      OR EXISTS (SELECT 1 FROM external_notes n JOIN external_note_items i ON i.external_note_id=n.id WHERE n.matched_txn_id=t.id AND LOWER(i.name) LIKE ?)) GROUP BY t.id ORDER BY t.occurred_on`).all(p.from, p.to, like, like, like, like, like) as any[];
  const byMonth = new Map<string, number>();
  for (const r of rows) byMonth.set(r.d.slice(0, 7), (byMonth.get(r.d.slice(0, 7)) ?? 0) + r.v);
  const months = Math.max(1, (Number(p.to.slice(0, 4)) * 12 + Number(p.to.slice(5, 7))) - (Number(p.from.slice(0, 4)) * 12 + Number(p.from.slice(5, 7))) + 1);
  const total = rows.reduce((a, r) => a + r.v, 0);
  return { totalCents: total, monthlyAverageCents: Math.round(total / months), count: rows.length, sparkline: [...byMonth].sort().map(([month, cents]) => ({ month, cents })) };
}

/** Ranked top-3 category suggestions (design §9.5): the suggesting rule, the merchant's past categories, then categories of similar descriptors. */
export function suggestionsFor(db: DB, t: { id: number; decided_rule_id: number | null; descriptor_clean: string | null }): { id: number; name: string; why: string }[] {
  const out: { id: number; name: string; why: string }[] = [];
  const add = (id: number | null | undefined, why: string) => { if (id && out.length < 3 && !out.some((o) => o.id === id)) { const c = db.prepare("SELECT name FROM categories WHERE id=? AND status='active'").get(id) as any; if (c) out.push({ id, name: c.name, why }); } };
  if (t.decided_rule_id) { const r = db.prepare('SELECT action_json FROM rules WHERE id=?').get(t.decided_rule_id) as any; const n = r ? JSON.parse(r.action_json).category : null; if (n) add((db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(n) as any)?.id, 'rule'); }
  const past = db.prepare(`SELECT s.category_id id, COUNT(*) n FROM transaction_splits s JOIN transactions x ON x.id=s.transaction_id JOIN transactions me ON me.id=? AND me.merchant_id IS NOT NULL AND x.merchant_id=me.merchant_id
    WHERE s.category_id IS NOT NULL AND x.id!=me.id GROUP BY s.category_id ORDER BY n DESC LIMIT 3`).all(t.id) as any[];
  for (const p of past) add(p.id, 'merchant history');
  if (t.descriptor_clean && out.length < 3) {
    const first = t.descriptor_clean.split(' ')[0];
    if (first.length >= 4) for (const r of db.prepare(`SELECT s.category_id id, COUNT(*) n FROM transaction_splits s JOIN transactions x ON x.id=s.transaction_id WHERE x.descriptor_clean LIKE ? AND s.category_id IS NOT NULL AND x.id!=? GROUP BY s.category_id ORDER BY n DESC LIMIT 3`).all(`${first}%`, t.id) as any[]) add(r.id, 'similar');
  }
  return out;
}

/** Inbox / "Needs you" (design §15.1). */
export function inbox(db: DB) {
  const rows = (where: string) => db.prepare(`SELECT t.id, t.occurred_on, t.amount_cents, t.descriptor_raw, t.descriptor_clean, t.status, t.kind, t.note_state, t.flag_reason, t.decided_rule_id, a.name account FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE t.status!='void' AND ${where} ORDER BY t.occurred_on DESC LIMIT 200`).all();
  return {
    needsCategory: (rows("t.kind NOT IN ('ignored','internal_transfer') AND (t.review_state='needs_category')") as any[]).map((t) => ({ ...t, suggestions: suggestionsFor(db, t) })),
    needsNote: rows("t.note_state IN ('needs_note','ambiguous','awaiting_note')"),
    staleProvisionals: rows("t.status='stale'"),
    flagged: rows('t.flagged=1'),
    greenlightRequests: db.prepare("SELECT r.*, p.display_name FROM greenlight_requests r JOIN greenlight_profiles p ON p.id=r.profile_id WHERE r.status='pending'").all(),
    unrecognized: db.prepare("SELECT id, source, received_at, payload, error FROM raw_events WHERE parse_status IN ('unrecognized','error') ORDER BY id DESC LIMIT 100").all(),
  };
}
