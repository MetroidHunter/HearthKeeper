import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createPlan, setPlanItem, makeLive, cancelScheduled, addPlanAction, planInEffect, planPhase } from '../src/core/plans.js';
import { createScenario } from '../src/core/earnings.js';
import { setBudget } from '../src/core/categories.js';
import { categoryBalance, currentAllocation } from '../src/core/balance.js';
import { budgetPage } from '../src/core/reports.js';

const TODAY = '2026-10-04';
function scene() {
  const h = seedHousehold();
  const sc = createScenario(h.db, 'S', [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
  const p1 = createPlan(h.db, 'Current', { livePlan: true }, '2026-10'); h.db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(sc, p1);
  makeLive(h.db, p1, { effectiveMonth: '2026-01', today: TODAY, confirmRestate: 'RESTATE' });
  return { h, p1, sc };
}
const versions = (h: ReturnType<typeof seedHousehold>) => h.db.prepare('SELECT category_id, effective_month, monthly_cents, plan_id FROM category_budget_versions ORDER BY category_id, effective_month').all();
const row = (h: ReturnType<typeof seedHousehold>, id: number) => h.db.prepare('SELECT * FROM budget_plans WHERE id=?').get(id) as any;

describe('cancelling a scheduled plan', () => {
  it('puts back the budget, the plan in force and the transfers, and returns the plan to a draft', () => {
    const { h, p1 } = scene();
    const d = createPlan(h.db, 'Next', { livePlan: true }, '2026-10');
    setPlanItem(h.db, d, h.cats['Groceries'], 95000);
    addPlanAction(h.db, d, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 1000 });
    const before = versions(h); const header = budgetPage(h.db, TODAY).header;
    makeLive(h.db, d, { effectiveMonth: '2026-11', today: TODAY });
    expect(planPhase(h.db, row(h, d), TODAY)).toBe('scheduled');
    expect(h.db.prepare("SELECT COUNT(*) n FROM envelope_transfers WHERE kind='manual'").get()).toEqual({ n: 1 });
    cancelScheduled(h.db, d, { today: TODAY });
    expect(versions(h)).toEqual(before);
    expect(h.db.prepare("SELECT COUNT(*) n FROM envelope_transfers WHERE kind='manual'").get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) n FROM envelope_transfer_legs').get()).toEqual({ n: 0 });
    expect(row(h, d)).toMatchObject({ status: 'draft', effective_month: null, made_live_at: null, income_snapshot_cents: null });
    expect(row(h, p1).status).toBe('live');
    expect(planInEffect(h.db, TODAY)?.id).toBe(p1);
    expect(budgetPage(h.db, TODAY).header).toEqual(header);
    expect(currentAllocation(h.db, '2026-11').byCategory[h.cats['Groceries']]).toBe(80000);
    // editable again, and it can go live again
    setPlanItem(h.db, d, h.cats['Groceries'], 91000);
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    expect(currentAllocation(h.db, '2026-12').byCategory[h.cats['Groceries']]).toBe(91000);
  });

  it('restores versions that go-live deleted (later ones) or overwrote (same month)', () => {
    const { h } = scene();
    setBudget(h.db, h.cats['Groceries'], 70000, '2026-11');   // will be overwritten
    setBudget(h.db, h.cats['Groceries'], 60000, '2027-02');   // will be dropped as "later"
    const d = createPlan(h.db, 'Next', { livePlan: true }, '2026-10'); setPlanItem(h.db, d, h.cats['Groceries'], 95000);
    const before = versions(h);
    makeLive(h.db, d, { effectiveMonth: '2026-11', today: TODAY });
    expect(versions(h)).not.toEqual(before);
    cancelScheduled(h.db, d, { today: TODAY });
    expect(versions(h)).toEqual(before);
  });

  it('cancelling a plan that superseded another puts the other back as scheduled', () => {
    const { h, p1 } = scene();
    const a = createPlan(h.db, 'December', { livePlan: true }, '2026-10'); setPlanItem(h.db, a, h.cats['Groceries'], 95000);
    makeLive(h.db, a, { effectiveMonth: '2026-12', today: TODAY });
    const b = createPlan(h.db, 'November', { livePlan: true }, '2026-10'); setPlanItem(h.db, b, h.cats['Groceries'], 70000);
    makeLive(h.db, b, { effectiveMonth: '2026-11', today: TODAY });
    cancelScheduled(h.db, b, { today: TODAY });
    expect(planPhase(h.db, row(h, a), TODAY)).toBe('scheduled');
    expect(planInEffect(h.db, '2026-12-05')?.id).toBe(a);
    expect(currentAllocation(h.db, '2026-12').byCategory[h.cats['Groceries']]).toBe(95000);
    expect(currentAllocation(h.db, '2026-11').byCategory[h.cats['Groceries']]).toBe(80000);
    expect(planInEffect(h.db, TODAY)?.id).toBe(p1);
  });

  it('only a scheduled plan can be cancelled', () => {
    const { h, p1 } = scene();
    const draft = createPlan(h.db, 'D', { livePlan: true }, '2026-10');
    const now = createPlan(h.db, 'ThisMonth', { livePlan: true }, '2026-10');
    expect(() => cancelScheduled(h.db, draft, { today: TODAY })).toThrow(/only a scheduled plan/i);
    expect(() => cancelScheduled(h.db, p1, { today: TODAY })).toThrow(/only a scheduled plan/i);
    makeLive(h.db, now, { effectiveMonth: '2026-10', today: TODAY });
    expect(() => cancelScheduled(h.db, now, { today: TODAY })).toThrow(/only a scheduled plan/i); // already in force
    // once its month arrives, a scheduled plan is in force and cannot be cancelled either
    const later = createPlan(h.db, 'Later', { livePlan: true }, '2026-10'); setPlanItem(h.db, later, h.cats['Groceries'], 1);
    makeLive(h.db, later, { effectiveMonth: '2026-11', today: TODAY });
    expect(() => cancelScheduled(h.db, later, { today: '2026-11-02' })).toThrow(/only a scheduled plan/i);
  });
});
