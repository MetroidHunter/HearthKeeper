import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { monthlySpend, categoryTrend, incomeVsSpend, treemap, yearPivot, budgetVsActual } from '../src/core/analytics.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { periodTotals } from '../src/core/balance.js';
import { setBudget } from '../src/core/categories.js';
import { createTransfer } from '../src/core/transfers.js';

function world() {
  const h = seedHousehold();
  const tx = (date: string, cents: number, cat: string, kind: 'spending' | 'income' = cents < 0 ? 'spending' : 'income') => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: date, amountCents: cents, kind, descriptor: 'X' }); setSplits(h.db, id, [{ categoryId: h.cats[cat], amountCents: cents }]); };
  tx('2026-07-10', -10000, 'Groceries'); tx('2026-07-12', 2000, 'Groceries'); // refund reduces Spent
  tx('2026-08-03', -5000, 'Groceries'); tx('2026-08-20', -3000, 'Eating Out'); tx('2026-09-02', -7000, 'Eating Out');
  tx('2026-08-15', 400000, 'Gig Income', 'income');
  createTransfer(h.db, 'manual', '2026-09-05', [{ categoryId: h.cats['Groceries'], cents: -9999 }, { categoryId: h.cats['Eating Out'], cents: 9999 }]); // transfers never show in spend charts
  return h;
}

describe('analytics aggregates', () => {
  it('monthly matrix nets refunds, ignores transfers and income, and agrees with periodTotals', () => {
    const h = world();
    const m = monthlySpend(h.db, '2026-07', '2026-09');
    expect(m.months).toEqual(['2026-07', '2026-08', '2026-09']);
    const g = m.rows.find((r) => r.key === 'Groceries')!;
    expect(g.values).toEqual([8000, 5000, 0]);
    expect(m.rows.find((r) => r.key === 'Gig Income')).toBeUndefined();
    for (const r of m.rows) r.values.forEach((v, i) => expect(v).toBe(periodTotals(h.db, r.id!, `${m.months[i]}-01`, `${m.months[i]}-31`).spent));
    const byGroup = monthlySpend(h.db, '2026-07', '2026-09', 'group');
    expect(byGroup.rows.find((r) => r.key === 'Food')!.total).toBe(8000 + 5000 + 3000 + 7000);
  });
  it('trend: trailing average, budget line follows versions, balance at month end', () => {
    const h = world();
    setBudget(h.db, h.cats['Groceries'], 90000, '2026-09');
    const t = categoryTrend(h.db, h.cats['Groceries'], '2026-07', '2026-09');
    expect(t.map((p) => p.spent)).toEqual([8000, 5000, 0]);
    expect(t.map((p) => p.budget)).toEqual([80000, 80000, 90000]);
    expect(t[1].trailingAvg).toBeCloseTo(6500);
    expect(t[2].balance).toBe(8 * 80000 + 90000 - (10000 - 2000 + 5000) - 9999); // Jan-Aug at 800, Sep at 900, minus net spend and the transfer out
  });
  it('income vs spend vs allocated, treemap, year pivot and budget-vs-actual are consistent', () => {
    const h = world();
    const iv = incomeVsSpend(h.db, '2026-07', '2026-09');
    expect(iv[1].income).toBe(400000); expect(iv[1].spent).toBe(8000);
    const alloc = 5000 + 40000 + 30000 + 80000 + 12500 + 1000; // expense targets
    expect(iv[0].allocated).toBe(alloc);
    const tm = treemap(h.db, '2026-07', '2026-09');
    expect(tm.reduce((a, g) => a + g.value, 0)).toBe(8000 + 5000 + 3000 + 7000);
    expect(tm[0].name).toBe('Food');
    const yp = yearPivot(h.db, 2025, 2026);
    expect(yp.years).toEqual([2025, 2026]);
    expect(yp.rows.find((r) => r.key === 'Groceries')!.values).toEqual([0, 13000]);
    const bva = budgetVsActual(h.db, '2026-08');
    expect(bva.find((r) => r.name === 'Groceries')).toMatchObject({ budget: 80000, spent: 5000 });
  });
});
