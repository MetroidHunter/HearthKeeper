import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createPlan, setPlanItem, makeLive, cancelScheduled, addPlanAction, planActions, applyDuePlanActions, diffPlan } from '../src/core/plans.js';
import { createScenario } from '../src/core/earnings.js';
import { categoryBalance } from '../src/core/balance.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { openNotices } from '../src/core/notices.js';

const TODAY = '2026-10-04';
function scene() {
  const h = seedHousehold();
  const sc = createScenario(h.db, 'S', [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
  const p1 = createPlan(h.db, 'Current', { livePlan: true }, '2026-10'); h.db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(sc, p1);
  makeLive(h.db, p1, { effectiveMonth: '2026-01', today: TODAY, confirmRestate: 'RESTATE' });
  const d = createPlan(h.db, 'Next', { livePlan: true }, '2026-10');
  return { h, d };
}
const status = (h: ReturnType<typeof seedHousehold>, name: string) => (h.db.prepare('SELECT status, retired_month FROM categories WHERE id=?').get(h.cats[name]) as any);
const manual = (h: ReturnType<typeof seedHousehold>) => h.db.prepare("SELECT occurred_on FROM envelope_transfers WHERE kind='manual' ORDER BY id").all() as { occurred_on: string }[];

describe('a plan\'s moves and retirements wait for the go-live month and happen together', () => {
  it('going live for a later month applies none of them yet, and does not block a retirement', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Eating Out'], cents: 1000 });
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'], moveBalanceTo: h.cats['Groceries'] });
    const diff = diffPlan(h.db, d, '2026-12', TODAY);
    expect(diff.blockers).toEqual([]);
    expect(diff.moves[0]).toMatchObject({ scheduled: true, date: '2026-12-01' });
    expect(diff.retires[0]).toMatchObject({ scheduled: true, canRetire: true });
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    expect(status(h, 'Manicure').status).toBe('active');
    expect(manual(h)).toEqual([]);
    expect(planActions(h.db, d).map((a) => a.applied_at)).toEqual([null, null]);
  });

  it('when the month arrives: moves first, then retirements, each once', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'], moveBalanceTo: h.cats['Groceries'] });
    addPlanAction(h.db, d, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Eating Out'], cents: 1000 });
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    expect(applyDuePlanActions(h.db, '2026-11-30')).toEqual({ applied: 0, failed: 0 });
    expect(status(h, 'Manicure').status).toBe('active');
    const gBefore = categoryBalance(h.db, h.cats['Groceries'], '2026-12-01').total!;
    const left = categoryBalance(h.db, h.cats['Manicure'], '2026-12-31').total!; // go-live already set December's budget to $0, so no December accrual
    expect(applyDuePlanActions(h.db, '2026-12-01')).toEqual({ applied: 2, failed: 0 });
    expect(manual(h).map((t) => t.occurred_on)).toEqual(['2026-12-01', '2026-12-01']); // the move, then the retirement's leftover
    expect(status(h, 'Manicure')).toEqual({ status: 'retired', retired_month: '2026-12' });
    expect(categoryBalance(h.db, h.cats['Groceries'], '2026-12-01').total).toBe(gBefore - 1000 + left);
    expect(planActions(h.db, d).every((a) => a.applied_at === '2026-12-01')).toBe(true);
    expect(applyDuePlanActions(h.db, '2026-12-02')).toEqual({ applied: 0, failed: 0 }); // only once
    expect(manual(h)).toHaveLength(2);
  });

  it('a retirement that cannot happen when the month arrives is left pending with the reason, and the user is told once; it goes through once fixed', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Eating Out'], cents: 1000 });
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'] });
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-11-15', amountCents: -5000000, descriptor: 'BIG' });
    setSplits(h.db, t, [{ categoryId: h.cats['Manicure'], amountCents: -5000000 }]);
    expect(applyDuePlanActions(h.db, '2026-12-01')).toEqual({ applied: 1, failed: 1 }); // the move still happens
    expect(status(h, 'Manicure').status).toBe('active');
    const retire = () => planActions(h.db, d).find((a) => a.kind === 'retire')!;
    expect(retire().applied_at).toBeNull(); expect(retire().error).toMatch(/Manicure.*overspent/);
    applyDuePlanActions(h.db, '2026-12-02');
    expect(openNotices(h.db).filter((n) => /Manicure/.test(n.message))).toHaveLength(1);
    // bring it back to $0 or more, then it retires on the next pass
    h.db.prepare("UPDATE transaction_splits SET amount_cents=-100 WHERE transaction_id=?").run(t); h.db.prepare('UPDATE transactions SET amount_cents=-100 WHERE id=?').run(t);
    expect(applyDuePlanActions(h.db, '2026-12-03')).toEqual({ applied: 1, failed: 0 });
    expect(status(h, 'Manicure').status).toBe('retired'); expect(retire().error).toBeNull();
  });

  it('cancelling before the month leaves nothing applied, and the draft keeps its actions', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'] });
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    cancelScheduled(h.db, d, { today: TODAY });
    expect(applyDuePlanActions(h.db, '2026-12-05')).toEqual({ applied: 0, failed: 0 });
    expect(status(h, 'Manicure').status).toBe('active');
    expect(planActions(h.db, d)).toHaveLength(1);
  });

  it('a plan overridden by an earlier one never applies its actions', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'] });
    makeLive(h.db, d, { effectiveMonth: '2026-12', today: TODAY });
    const e = createPlan(h.db, 'Sooner', { livePlan: true }, '2026-10'); setPlanItem(h.db, e, h.cats['Groceries'], 70000);
    makeLive(h.db, e, { effectiveMonth: '2026-11', today: TODAY });
    expect(applyDuePlanActions(h.db, '2026-12-05')).toEqual({ applied: 0, failed: 0 });
    expect(status(h, 'Manicure').status).toBe('active');
  });

  it('for the current month everything still happens at once, and is marked done', () => {
    const { h, d } = scene();
    addPlanAction(h.db, d, { kind: 'retire', categoryId: h.cats['Manicure'] });
    addPlanAction(h.db, d, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Eating Out'], cents: 1000 });
    makeLive(h.db, d, { effectiveMonth: '2026-10', today: TODAY });
    expect(status(h, 'Manicure').status).toBe('retired');
    expect(planActions(h.db, d).every((a) => a.applied_at === TODAY)).toBe(true);
  });
});
