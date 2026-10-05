import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createPlan, setPlanItem, diffPlan, makeLive } from '../src/core/plans.js';
import { setBudget, budgetHistory } from '../src/core/categories.js';
import { categoryBalance } from '../src/core/balance.js';

describe('review fixes: plan go-live', () => {
  it('go-live removes later budget versions that would silently override the plan', () => {
    const h = seedHousehold();
    const c = h.cats['Groceries'];
    setBudget(h.db, c, 50000, '2026-08', { reason: 'legacy' });
    setBudget(h.db, c, 70000, '2026-12', { reason: 'legacy' });
    const p = createPlan(h.db, 'P', { livePlan: true }, '2026-10');
    setPlanItem(h.db, p, c, 60000);
    expect(diffPlan(h.db, p, '2026-10', '2026-10-04').rows.map((r) => r.categoryId)).toContain(c);
    makeLive(h.db, p, { effectiveMonth: '2026-10', today: '2026-10-04' });
    const hist = budgetHistory(h.db, c).map((x) => x.effective_month);
    expect(hist).not.toContain('2026-12');
    expect(categoryBalance(h.db, c, '2027-01-15').accrued).toBeGreaterThan(0);
  });
  it('plan items for retired categories are ignored at go-live', () => {
    const h = seedHousehold();
    const c = h.cats['Groceries'];
    const p = createPlan(h.db, 'P', { livePlan: true }, '2026-10');
    setPlanItem(h.db, p, c, 60000);
    h.db.prepare("UPDATE categories SET status='retired' WHERE id=?").run(c);
    expect(diffPlan(h.db, p, '2026-10', '2026-10-04').rows.map((r) => r.categoryId)).not.toContain(c);
  });
});

import { retireCategory } from '../src/core/categories.js';
import { proposeRebalance } from '../src/core/transfers.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
describe('review fixes: rounding and retire', () => {
  it('retire moves the balance as of the real month end (31-day month spend counts)', () => {
    const h = seedHousehold();
    const c = h.cats['Groceries'], to = h.cats['Eating Out'];
    setBudget(h.db, c, 10000, '2026-01', { reason: 'legacy' });
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-01-31', amountCents: -2000, descriptor: 'LATE' });
    setSplits(h.db, id, [{ categoryId: c, amountCents: -2000 }]);
    const r = retireCategory(h.db, c, '2026-01', { moveBalanceTo: to, actor: 'test' });
    expect(r.remainingCents).toBe(-2000); // the Jan-31 spend is included (old asOf was the 28th)
    expect(categoryBalanceAt(h, c)).toBe(0);
  });
  it('rebalance never proposes a fractional-cent move', () => {
    const h = seedHousehold();
    const p = proposeRebalance(h.db, '2026-10-04');
    for (const m of [...p.donorMoves, ...p.poolPayments]) expect(Number.isInteger(m.cents)).toBe(true);
  });
});
import { categoryBalance as cb } from '../src/core/balance.js';
function categoryBalanceAt(h: any, c: number) { return cb(h.db, c, '2026-01-31').total ?? 0; }
