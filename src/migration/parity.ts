import type { DB } from '../core/db.js';
import { categoryBalance, periodTotals, currentAllocation } from '../core/balance.js';
import { monthsInclusive, monthOf } from '../core/time.js';
import { parseCents } from '../core/money.js';
import { parseCsv } from '../ingest/csv.js';
import { NEEDS_CATEGORY } from './sheet.js';

/** Oracle exports captured from the sheet on the same day (design §18.1). All amounts in dollars as the sheet shows them. */
export interface Oracle {
  internalAB?: string;   // category, lifetime transaction sum         (Internal!A:B)
  internalHJ?: string;   // category, months, total                    (Internal!H:J)
  budgetCurrent?: string; // category, current                          (Budget!D)
  periods?: string;      // category, spent_this, gained_this, spent_last, gained_last   (Internal!M:W / Budget!E:H)
  allocated?: string;    // single value: Budget!C2
  txnCount?: number; txnTotal?: string;  // Transactions: row count and total amount
}
export interface Check { test: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'; subject: string; sheet: number | string; app: number | string; diff?: number; explained?: string }
export interface ParityReport { asOf: string; checks: Check[]; mismatches: Check[]; unexplained: Check[]; passed: boolean }

const lc = (s: string) => s.trim().toLowerCase();
function kv(csv: string | undefined, cols: number): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!csv) return m;
  for (const r of parseCsv(csv)) { const [k, ...rest] = r; if (!k || /^(category|name)$/i.test(k.trim())) continue; m.set(lc(k), rest.slice(0, cols - 1).map((x) => x.trim())); }
  return m;
}
const usd = (s: string | undefined) => (s === undefined || s === '' || /^n\/a$/i.test(s) ? 0 : parseCents(s));

/** Legacy null-category splits count as the NEEDS CATEGORY pseudo-category for parity (§18.2). */
function pseudoNeeds(db: DB, asOf: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(s.amount_cents),0) v FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id WHERE s.category_id IS NULL AND s.memo LIKE 'legacy:%' AND t.occurred_on<=?`).get(asOf) as any).v;
}
function lifetimeTxn(db: DB, categoryId: number, asOf: string): number {
  const b = categoryBalance(db, categoryId, asOf);
  return b.splits + b.transfers;
}

export function runParity(db: DB, asOf: string, oracle: Oracle, explanations: Record<string, string> = {}): ParityReport {
  const checks: Check[] = [];
  const add = (c: Check) => { c.diff = typeof c.sheet === 'number' && typeof c.app === 'number' ? (c.app as number) - c.sheet : undefined; checks.push(c); };
  const cats = db.prepare('SELECT id, name, start_month FROM categories').all() as any[];
  const byName = new Map(cats.map((c) => [lc(c.name), c]));

  for (const [k, v] of kv(oracle.internalHJ, 3)) {
    const c = byName.get(k); if (!c) { add({ test: 'P1', subject: `${k} (months)`, sheet: Number(v[0]), app: 'missing category' }); continue; }
    add({ test: 'P1', subject: `${c.name} months`, sheet: Number(v[0]), app: monthsInclusive(c.start_month, monthOf(asOf)) });
    add({ test: 'P1', subject: `${c.name} total`, sheet: usd(v[1]), app: categoryBalance(db, c.id, asOf).accrued });
  }
  for (const [k, v] of kv(oracle.internalAB, 2)) {
    if (k === lc(NEEDS_CATEGORY)) { add({ test: 'P2', subject: `${NEEDS_CATEGORY} lifetime txns`, sheet: usd(v[0]), app: pseudoNeeds(db, asOf) }); continue; }
    const c = byName.get(k); if (!c) { add({ test: 'P2', subject: k, sheet: usd(v[0]), app: 'missing category' }); continue; }
    add({ test: 'P2', subject: `${c.name} lifetime txns`, sheet: usd(v[0]), app: lifetimeTxn(db, c.id, asOf) });
  }
  for (const [k, v] of kv(oracle.budgetCurrent, 2)) {
    if (/n\/a/i.test(v[0] ?? '')) continue; // income_reference categories show N/A
    const c = byName.get(k); if (!c) continue;
    add({ test: 'P3', subject: `${c.name} current`, sheet: usd(v[0]), app: (categoryBalance(db, c.id, asOf).total ?? 0) + (k === lc(NEEDS_CATEGORY) ? pseudoNeeds(db, asOf) : 0) });
  }
  if (oracle.periods) {
    const thisFrom = `${monthOf(asOf)}-01`, thisTo = `${monthOf(asOf)}-31`;
    const [y, m] = monthOf(asOf).split('-').map(Number);
    const lastM = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    for (const [k, v] of kv(oracle.periods, 5)) {
      const c = byName.get(k); if (!c) continue;
      const a = periodTotals(db, c.id, thisFrom, thisTo, { sheetCompatible: true }), b = periodTotals(db, c.id, `${lastM}-01`, `${lastM}-31`, { sheetCompatible: true });
      add({ test: 'P4', subject: `${c.name} spent (this)`, sheet: usd(v[0]), app: a.spent }); add({ test: 'P4', subject: `${c.name} gained (this)`, sheet: usd(v[1]), app: a.gained });
      add({ test: 'P4', subject: `${c.name} spent (last)`, sheet: usd(v[2]), app: b.spent }); add({ test: 'P4', subject: `${c.name} gained (last)`, sheet: usd(v[3]), app: b.gained });
    }
  }
  if (oracle.txnCount !== undefined) {
    const n = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE status!='void'").get() as any).c + (db.prepare("SELECT COUNT(*) c FROM envelope_transfer_legs l JOIN envelope_transfers e ON e.id=l.transfer_id WHERE e.kind IN ('legacy','adjustment')").get() as any).c;
    add({ test: 'P5', subject: 'transaction count', sheet: oracle.txnCount, app: n });
  }
  if (oracle.txnTotal !== undefined) {
    const t = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) v FROM transactions WHERE status!='void'").get() as any).v + (db.prepare("SELECT COALESCE(SUM(l.amount_cents),0) v FROM envelope_transfer_legs l JOIN envelope_transfers e ON e.id=l.transfer_id WHERE e.kind IN ('legacy','adjustment')").get() as any).v;
    add({ test: 'P5', subject: 'transaction total', sheet: parseCents(oracle.txnTotal), app: t });
  }
  if (oracle.allocated) add({ test: 'P6', subject: 'allocated total', sheet: parseCents(oracle.allocated.trim()), app: currentAllocation(db, monthOf(asOf)).allocated });

  const mismatches = checks.filter((c) => c.sheet !== c.app);
  for (const c of mismatches) c.explained = explanations[`${c.test}:${c.subject}`] ?? explanations[c.subject];
  const unexplained = mismatches.filter((c) => !c.explained);
  return { asOf, checks, mismatches, unexplained, passed: unexplained.length === 0 };
}

export function formatParity(r: ParityReport): string {
  const lines = [`Parity as of ${r.asOf}: ${r.checks.length} checks, ${r.mismatches.length} mismatches, ${r.unexplained.length} unexplained -> ${r.passed ? 'PASS' : 'FAIL'}`];
  for (const m of r.mismatches) lines.push(`  [${m.test}] ${m.subject}: sheet=${m.sheet} app=${m.app}${m.diff !== undefined ? ` (diff ${m.diff})` : ''}${m.explained ? ` — explained: ${m.explained}` : ''}`);
  return lines.join('\n');
}
