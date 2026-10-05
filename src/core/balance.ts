import type { DB } from './db.js';
import { monthsInclusive, monthOf, addMonths } from './time.js';

export interface Version { effective_month: string; monthly_cents: number }

/** monthly_amount(c, m): version with greatest effective_month <= m, else 0 (design §6.1). */
export function monthlyAmount(versions: Version[], month: string): number {
  let best: Version | undefined;
  for (const v of versions) if (v.effective_month <= month && (!best || v.effective_month > best.effective_month)) best = v;
  return best ? best.monthly_cents : 0;
}

/** accrued(c, asOf): sum of monthly amounts from start_month through month(asOf), inclusive. */
export function accrued(startMonth: string, versions: Version[], asOf: string): number {
  const n = monthsInclusive(startMonth, monthOf(asOf));
  let total = 0;
  for (let i = 0; i < n; i++) total += monthlyAmount(versions, addMonths(startMonth, i));
  return total;
}

export interface CategoryRow { id: number; name: string; kind: string; start_month: string; status: string; group_id: number | null; discretionary: number; cushion_cents: number | null; overage_priority: number | null }

export function getVersions(db: DB, categoryId: number): Version[] {
  return db.prepare('SELECT effective_month, monthly_cents FROM category_budget_versions WHERE category_id=?').all(categoryId) as Version[];
}

export interface BalanceParts { splits: number; transfers: number; accrued: number; total: number | null }

/** Full balance of a category as of a local date (inclusive). income_reference categories return total=null (N/A). */
export function categoryBalance(db: DB, categoryId: number, asOf: string): BalanceParts {
  const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId) as CategoryRow;
  const splits = (db.prepare(`SELECT COALESCE(SUM(s.amount_cents),0) v FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
     WHERE s.category_id=? AND t.occurred_on<=? AND t.status!='void'`).get(categoryId, asOf) as { v: number }).v;
  const transfers = (db.prepare(`SELECT COALESCE(SUM(l.amount_cents),0) v FROM envelope_transfer_legs l JOIN envelope_transfers e ON e.id=l.transfer_id
     WHERE l.category_id=? AND e.occurred_on<=?`).get(categoryId, asOf) as { v: number }).v;
  const acc = accrued(cat.start_month, getVersions(db, categoryId), asOf);
  return { splits, transfers, accrued: acc, total: cat.kind === 'income_reference' ? null : splits + transfers + acc };
}

export interface PeriodTotals { spent: number; gained: number }

/** Spent / Gained for [from, to] using splits only (never transfers or accruals), design §14.1. */
export function periodTotals(db: DB, categoryId: number, from: string, to: string, opts: { sheetCompatible?: boolean } = {}): PeriodTotals {
  const rows = db.prepare(`SELECT s.amount_cents a FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id
    WHERE s.category_id=? AND t.occurred_on BETWEEN ? AND ? AND t.status!='void'`).all(categoryId, from, to) as { a: number }[];
  const cat = db.prepare('SELECT kind FROM categories WHERE id=?').get(categoryId) as { kind: string };
  let spent = 0, gained = 0;
  if (opts.sheetCompatible || cat.kind !== 'expense') {
    for (const r of rows) { if (r.a < 0) spent -= r.a; else gained += r.a; }
  } else {
    // Refunds and Greenlight offsets reduce Spent (D13): spent is net outflow.
    let net = 0;
    for (const r of rows) net += r.a;
    spent = 0 - net; // `0 - x`, not `-x`: never produce negative zero
  }
  if (opts.sheetCompatible) {
    // The sheet's [rR]eingest exclusion misses some legacy names; reproduce that leak (design §18.2).
    const legs = db.prepare(`SELECT l.amount_cents a, e.legacy_name n FROM envelope_transfer_legs l JOIN envelope_transfers e ON e.id=l.transfer_id
      WHERE l.category_id=? AND e.kind IN ('legacy','adjustment') AND e.occurred_on BETWEEN ? AND ?`).all(categoryId, from, to) as { a: number; n: string | null }[];
    for (const l of legs) {
      if (l.n && /[rR]eingest/.test(l.n)) continue;
      if (l.a < 0) spent -= l.a; else gained += l.a;
    }
  }
  return { spent, gained };
}

export interface AllocationSummary { allocated: number; byCategory: Record<number, number> }
export function currentAllocation(db: DB, month: string): AllocationSummary {
  const cats = db.prepare("SELECT id, kind FROM categories WHERE status='active'").all() as { id: number; kind: string }[];
  const byCategory: Record<number, number> = {};
  let allocated = 0;
  for (const c of cats) {
    const m = monthlyAmount(getVersions(db, c.id), month);
    byCategory[c.id] = m;
    if (c.kind === 'expense') allocated += m;
  }
  return { allocated, byCategory };
}

/** Invariants of design §7.8 over the stored data; returns human-readable violations. */
export function checkInvariants(db: DB): string[] {
  const out: string[] = [];
  const bad = db.prepare(`SELECT t.id, t.kind, t.amount_cents, COALESCE(SUM(s.amount_cents),0) s, COUNT(s.id) n FROM transactions t LEFT JOIN transaction_splits s ON s.transaction_id=t.id
    WHERE t.status!='void' AND t.kind IN ('spending','income','greenlight_allowance','greenlight_return','greenlight_reclass') AND t.legacy_group IS NULL GROUP BY t.id`).all() as any[];
  for (const t of bad) {
    if (t.kind === 'greenlight_reclass') { if (t.s !== 0) out.push(`txn ${t.id}: reclass splits sum ${t.s} != 0`); }
    else if (t.n > 0 && t.s !== t.amount_cents) out.push(`txn ${t.id}: splits ${t.s} != amount ${t.amount_cents}`);
  }
  const legs = db.prepare(`SELECT e.id, e.kind, SUM(l.amount_cents) s FROM envelope_transfers e JOIN envelope_transfer_legs l ON l.transfer_id=e.id
    WHERE e.kind IN ('reconcile','pool_payment','placement','manual') GROUP BY e.id HAVING s != 0`).all() as any[];
  for (const l of legs) out.push(`transfer ${l.id} (${l.kind}): legs sum ${l.s} != 0`);
  const retired = db.prepare(`SELECT c.id, c.name FROM categories c WHERE c.status='retired' AND COALESCE((SELECT monthly_cents FROM category_budget_versions v WHERE v.category_id=c.id ORDER BY effective_month DESC LIMIT 1),0) != 0`).all() as any[];
  for (const r of retired) out.push(`category ${r.name}: retired but last version non-zero`);
  return out;
}
