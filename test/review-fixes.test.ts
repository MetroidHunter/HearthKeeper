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
