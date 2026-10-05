import { describe, it, expect } from 'vitest';
import { openDb } from '../src/core/db.js';
import { importSheets } from '../src/migration/sheet.js';
import { runParity, formatParity } from '../src/migration/parity.js';
import { checkInvariants } from '../src/core/balance.js';

const ASOF = '2026-07-05';
const LIST = `Name,Parent,Start Date,Deprecated,Usages
Groceries,Food,1/1/2020,,
Eating Out,Food,3/1/2021,,
Manicure,Personal,1/1/2022,,
Rent,Housing,1/1/2020,TRUE,
Gig Income,Income,1/1/2020,,
Salary,Income,1/1/2020,,
Lovesac Couch,Home,6/1/2023,,
Goods,Misc,1/1/2020,,
NEEDS CATEGORY,Goods,1/1/2020,,
Boiling Point,Eating,1/1/2022,,
`;
const HISTORY = `Category,Amount,Month Stopped Using
Groceries,$600.00,1/1/2022
Groceries,$700.00,1/1/2023
Groceries,$650.00,6/1/2022
Eating Out,$200.00,1/1/2024
Rent,$1500.00,1/1/2021
Lovesac Couch,$100.00,1/1/2024
,$50.00,1/1/2024
Manicure,$50.00,
Groceries,$500.00,12/1/2019
`;
const BUDGET = `,Expected income,"$12,466.67"
,Allocated,
Parent,Name,Budget,Current
Food,Groceries,$800.00,
Food,Eating Out,$300.00,
Personal,Manicure,$125.00,
Income,Gig Income,$0.00,
Income,Salary,$0.00,
Misc,Goods,$0.00,
Misc,NEEDS CATEGORY,$0.00,
Food,Groceries,$800.00,
,Total spent text below,,
`;
const TXNS = `Date,Name,Category,Amount,Notes,Split Total
1/5/2020,Groceries Ingest,Groceries,"$1,000.00",opening,
2/3/2022,Safeway,Groceries,-$120.50,,
2/3/2022,Costco,Groceries,-$30.50,,183.02
2/3/2022,Costco,Eating Out,-$30.50,,183.02
2/3/2022,Costco,Manicure,-$122.01,,183.02
3/9/2024,Reingest Eating Out,Eating Out,$75.00,,
3/9/2024,Reingest Groceries,Groceries,-$75.00,,
4/1/2024,Zero Out Manicure,Manicure,-$500.00,,
5/2/2025,ZELLE FROM PREMIER VOCAL ENTERTAINMENT,NEEDS CATEGORY,$300.00,,
5/3/2025,Mystery charge,,-$12.34,??? check,
6/1/2025,Old rent,Rent,-$1500.00,,
6/2/2025,Sold thing,Gig Income,$250.00,,
6/3/2025,Paycheck,Salary,"$6,500.00",,
6/4/2025,Hat,Hats,-$20.00,,
6/5/2026,Pizza,Eating Out,-$40.00,,
6/20/2026,Refund pizza,Eating Out,$10.00,,
7/1/2026,Reignest Patreon,Groceries,$5.00,,
`;

// ---- Independent reference: the sheet's historicalBudget() semantics, written differently from the migration ----
const idx = (m: string) => { const [y, mo] = m.split('-').map(Number); return y * 12 + mo - 1; };
const mo = (d: string) => { const [m, , y] = d.split('/'); return `${y}-${m.padStart(2, '0')}`; };
function refAccrued(start: string, rows: { stop: string; amt: number }[], current: number | null, asOfMonth: string) {
  // like the real sheet: only categories present in Budget (current !== null) get the final segment through today
  let prev = start, total = 0, months = 0;
  for (const r of [...rows].sort((a, b) => idx(a.stop) - idx(b.stop))) {
    const diff = idx(r.stop) - idx(prev);
    if (diff <= 0) continue;
    total += diff * r.amt; months += diff; prev = r.stop;
  }
  const last = idx(asOfMonth) - idx(prev) + 1;
  if (current !== null && last > 0) { total += last * (current ?? 0); months += last; }
  return { total, months };
}

describe('legacy migration + parity (synthetic sheet export)', () => {
  const db = openDb();
  const rep = importSheets(db, { list: LIST, history: HISTORY, budget: BUDGET, transactions: TXNS });

  it('reports the data problems the sheet hides', () => {
    expect(rep.droppedHistoryRows).toEqual([{ category: 'Groceries', stop: '2019-12', amountCents: 50000, reason: expect.any(String) }]);
    expect(rep.duplicateBudgetRows).toEqual(['Groceries']);
    expect(rep.strayBudgetRows).toContain('Total spent text below');
    expect(rep.categoriesMissingFromList).toEqual(['Hats']);
    expect(rep.needsCategoryRows).toBe(1);
    expect(rep.blankCategoryRows).toBe(1);
    expect(rep.noteFlags).toBe(1);
    expect(rep.reallocationRows.map((r) => [r.name, r.kind])).toEqual([['Groceries Ingest', 'legacy'], ['Reingest Eating Out', 'legacy'], ['Reingest Groceries', 'legacy'], ['Zero Out Manicure', 'adjustment'], ['Reignest Patreon', 'legacy']]);
    expect(rep.legacySplitGroups).toEqual([{ key: '2022-02-03|Costco|183.02', rows: 3, sum: -18301, splitTotal: 18302, balanced: false }]);
    expect(rep.errors).toEqual([]);
  });

  it('Rent (in History, absent from Budget) retires with a final 0 version; Lovesac flagged as likely retired', () => {
    expect((db.prepare("SELECT status FROM categories WHERE name='Rent'").get() as any).status).toBe('retired');
    expect((db.prepare("SELECT status FROM categories WHERE name='Lovesac Couch'").get() as any).status).toBe('retired');
    expect(rep.likelyRetiredButUnflagged).toEqual(['Boiling Point']);
  });

  it('P1-P6 hold against an independently computed sheet oracle', () => {
    const asOfMonth = '2026-07';
    const hist = (name: string) => HISTORY.split('\n').slice(1).filter((l) => l.startsWith(name + ',') && l.split(',')[2]).map((l) => { const c = l.split(','); return { stop: mo(c[2]), amt: Number(c[1].replace('$', '')) * 100 }; });
    const spec: [string, string, number | null][] = [['Groceries', '2020-01', 80000], ['Eating Out', '2021-03', 30000], ['Manicure', '2022-01', 12500], ['Rent', '2020-01', null], ['Gig Income', '2020-01', 0], ['Salary', '2020-01', 0], ['Lovesac Couch', '2023-06', null], ['Goods', '2020-01', 0], ['NEEDS CATEGORY', '2020-01', 0], ['Hats', '2025-06', null], ['Boiling Point', '2022-01', null]];
    const hj: string[] = [], ab: string[] = [], cur: string[] = [];
    const txnSum: Record<string, number> = { Groceries: 100000 - 12050 - 3050 - 7500 + 500, 'Eating Out': -3050 + 7500 - 4000 + 1000, Manicure: -12201 - 50000, Rent: -150000, 'Gig Income': 25000, Salary: 650000, Hats: -2000, 'NEEDS CATEGORY': 30000 };
    for (const [name, start, now] of spec) {
      const { total, months } = refAccrued(start, hist(name), now, asOfMonth);
      if (months > 0) hj.push(`${name},${months},${(total / 100).toFixed(2)}`); // the sheet emits no row for a category with no Budget row and no History
      ab.push(`${name},${((txnSum[name] ?? 0) / 100).toFixed(2)}`);
      if (name !== 'Salary') cur.push(`${name},${(((txnSum[name] ?? 0) + total) / 100).toFixed(2)}`);
    }
    ab.push('(blank),-12.34');
    const n = TXNS.trim().split('\n').length - 1;
    const total = Object.values(txnSum).reduce((a, b) => a + b, 0) - 1234; // plus the blank-category row (-12.34)
    const rpt = runParity(db, ASOF, {
      internalHJ: hj.join('\n'), internalAB: ab.join('\n'), budgetCurrent: cur.join('\n'),
      txnCount: n, txnTotal: (total / 100).toFixed(2), allocated: '1225.00',
    });
    expect(formatParity(rpt)).toContain('PASS');
    expect(rpt.checks.length).toBeGreaterThan(30);
    expect(rpt.unexplained).toEqual([]);
  });

  it('parity detects an injected error and honors explanations', () => {
    const bad = runParity(db, ASOF, { internalAB: 'Groceries,999.00' });
    expect(bad.passed).toBe(false);
    const ok = runParity(db, ASOF, { internalAB: 'Groceries,999.00' }, { 'Groceries lifetime txns': 'known sheet bug' });
    expect(ok.passed).toBe(true);
  });

  it('sheet-compatible period totals reproduce the Zero Out leak but exclude Reingest', () => {
    const r = runParity(db, '2024-04-15', { periods: 'Manicure,500.00,0,0,0\nEating Out,0,0,0,0\nGroceries,0,0,0,0' });
    const m = r.checks.filter((c) => c.subject.startsWith('Manicure'));
    expect(m.find((c) => c.subject.includes('spent (this)'))!.app).toBe(50000); // Zero Out leaks into Spent
    expect(r.checks.filter((c) => c.subject.startsWith('Eating Out')).find((c) => c.subject.includes('gained (last)'))!.app).toBe(0);
  });

  it('invariants hold after import', () => { expect(checkInvariants(db)).toEqual([]); });
});
