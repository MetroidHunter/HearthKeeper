import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createPlan, setPlanItem, diffPlan, makeLive, planPhase, planInEffect, addPlanAction, removePlanAction, planActions, planDetail } from '../src/core/plans.js';
import { createScenario } from '../src/core/earnings.js';
import { categoryBalance, currentAllocation, checkInvariants } from '../src/core/balance.js';
import { budgetPage } from '../src/core/reports.js';

const TODAY = '2026-10-04';
/** A live plan (with income) already in force, then a draft from it. */
function scene() {
  const h = seedHousehold();
  const live = createScenario(h.db, 'Now', [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
  const next = createScenario(h.db, 'Later', [{ label: 'x', annualSalaryCents: 30000000, taxRateBp: 3200 }]);
  const p1 = createPlan(h.db, 'Current', { livePlan: true }, '2026-10');
  h.db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(live, p1);
  makeLive(h.db, p1, { effectiveMonth: '2026-01', today: TODAY, confirmRestate: 'RESTATE' });
  const draft = createPlan(h.db, 'Next', { livePlan: true }, '2026-10');
  h.db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(next, draft);
  return { h, p1, draft, live, next };
}

describe('the go-live month is respected', () => {
  it('a plan going live next month changes next month\'s budget and not this month\'s', () => {
    const { h, draft } = scene();
    setPlanItem(h.db, draft, h.cats['Groceries'], 95000);
    makeLive(h.db, draft, { effectiveMonth: '2026-11', today: TODAY });
    expect(currentAllocation(h.db, '2026-10').byCategory[h.cats['Groceries']]).toBe(80000);
    expect(currentAllocation(h.db, '2026-11').byCategory[h.cats['Groceries']]).toBe(95000);
    // this month's balance is untouched
    const bal = categoryBalance(h.db, h.cats['Groceries'], TODAY).total;
    expect(bal).toBe(10 * 80000);
  });

  it('until the month arrives, the plan is "scheduled" and the Budget page still shows the plan and income in force', () => {
    const { h, p1, draft } = scene();
    const incomeNow = (h.db.prepare('SELECT income_snapshot_cents v FROM budget_plans WHERE id=?').get(p1) as any).v;
    setPlanItem(h.db, draft, h.cats['Groceries'], 95000);
    makeLive(h.db, draft, { effectiveMonth: '2026-11', today: TODAY });
    const row = (id: number) => h.db.prepare('SELECT * FROM budget_plans WHERE id=?').get(id) as any;
    expect(planPhase(h.db, row(draft), TODAY)).toBe('scheduled');
    expect(planInEffect(h.db, TODAY)?.id).toBe(p1);
    expect(planPhase(h.db, row(p1), TODAY)).toBe('live'); // still the one in force
    const page = budgetPage(h.db, TODAY).header;
    expect(page.livePlan).toBe('Current');
    expect(page.incomeCents).toBe(incomeNow);
    // in November the new plan is the live one
    expect(planInEffect(h.db, '2026-11-01')?.id).toBe(draft);
    expect(planPhase(h.db, row(draft), '2026-11-01')).toBe('live');
    expect(planPhase(h.db, row(p1), '2026-11-01')).toBe('archived');
    expect(budgetPage(h.db, '2026-11-02').header.livePlan).toBe('Next');
  });

  it('going live for the current month takes effect now; the diff names the exact month', () => {
    const { h, draft } = scene();
    setPlanItem(h.db, draft, h.cats['Groceries'], 95000);
    const d = diffPlan(h.db, draft, '2026-10', TODAY);
    expect(d.effectiveMonth).toBe('2026-10');
    expect(d.retroactive).toBe(false);
    // the current month's accrual changes with it, so the balance moves by the difference and the dialog says so
    expect(d.rows[0].restatedBalanceDeltaCents).toBe(15000);
    makeLive(h.db, draft, { effectiveMonth: '2026-10', today: TODAY });
    expect(planPhase(h.db, h.db.prepare('SELECT * FROM budget_plans WHERE id=?').get(draft) as any, TODAY)).toBe('live');
    expect(budgetPage(h.db, TODAY).header.livePlan).toBe('Next');
  });

  it('a later plan for an earlier month supersedes a plan that has not taken effect yet', () => {
    const { h, p1, draft } = scene();
    setPlanItem(h.db, draft, h.cats['Groceries'], 95000);
    makeLive(h.db, draft, { effectiveMonth: '2026-12', today: TODAY });
    const d2 = createPlan(h.db, 'Sooner', { livePlan: true }, '2026-10');
    setPlanItem(h.db, d2, h.cats['Groceries'], 70000);
    makeLive(h.db, d2, { effectiveMonth: '2026-11', today: TODAY });
    expect(planInEffect(h.db, '2026-12-05')?.id).toBe(d2); // not the December plan, which never took effect
    expect(currentAllocation(h.db, '2026-12').byCategory[h.cats['Groceries']]).toBe(70000);
    expect(planInEffect(h.db, TODAY)?.id).toBe(p1);
  });
});

describe('plan actions: move money and retire at go-live', () => {
  it('a move is dated the first of the go-live month, conserves money, and is listed in the diff', () => {
    const { h, draft } = scene();
    const before = categoryBalance(h.db, h.cats['Groceries'], TODAY).total!;
    const beforeTo = categoryBalance(h.db, h.cats['Manicure'], TODAY).total!;
    addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 25000 });
    const d = diffPlan(h.db, draft, '2026-10', TODAY);
    expect(d.moves).toMatchObject([{ fromName: 'Groceries', toName: 'Manicure', cents: 25000, date: '2026-10-01', fromAfterCents: before - 25000, toAfterCents: beforeTo + 25000, warning: null }]);
    makeLive(h.db, draft, { effectiveMonth: '2026-10', today: TODAY });
    expect(categoryBalance(h.db, h.cats['Groceries'], TODAY).total).toBe(before - 25000);
    expect(categoryBalance(h.db, h.cats['Manicure'], TODAY).total).toBe(beforeTo + 25000);
    const t = h.db.prepare("SELECT occurred_on, memo FROM envelope_transfers WHERE kind='manual'").get() as any;
    expect(t.occurred_on).toBe('2026-10-01'); expect(t.memo).toMatch(/plan: Next/);
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('a move into next month does not touch this month\'s balances', () => {
    const { h, draft } = scene();
    const before = categoryBalance(h.db, h.cats['Groceries'], TODAY).total!;
    addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 25000 });
    makeLive(h.db, draft, { effectiveMonth: '2026-11', today: TODAY });
    expect(categoryBalance(h.db, h.cats['Groceries'], TODAY).total).toBe(before);
    expect(categoryBalance(h.db, h.cats['Groceries'], '2026-11-01').total).toBe(before + 80000 - 25000);
  });

  it('a move that overdraws its source is a warning, not a block', () => {
    const { h, draft } = scene();
    addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Fees and Taxes'], toCategoryId: h.cats['Manicure'], cents: 5000000 });
    const d = diffPlan(h.db, draft, '2026-10', TODAY);
    expect(d.moves[0].warning).toMatch(/Fees and Taxes.*overspent/);
    expect(d.blockers).toEqual([]);
  });

  it('rejects a bad move: same envelope, no amount, unknown category, non-draft plan', () => {
    const { h, p1, draft } = scene();
    const g = h.cats['Groceries'];
    expect(() => addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: g, toCategoryId: g, cents: 100 })).toThrow(/different/);
    expect(() => addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: g, toCategoryId: h.cats['Manicure'], cents: 0 })).toThrow(/more than \$0/);
    expect(() => addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: g, toCategoryId: 99999, cents: 100 })).toThrow(/category/i);
    expect(() => addPlanAction(h.db, p1, { kind: 'move', fromCategoryId: g, toCategoryId: h.cats['Manicure'], cents: 100 })).toThrow(/draft/);
  });

  it('retiring at go-live zeroes the budget from that month, moves the leftover, and retires the category', () => {
    const { h, draft } = scene();
    const left = categoryBalance(h.db, h.cats['Manicure'], '2026-10-31').total! - 12500; // the October accrual stops with the retirement
    expect(left).toBeGreaterThan(0);
    addPlanAction(h.db, draft, { kind: 'retire', categoryId: h.cats['Manicure'], moveBalanceTo: h.cats['Groceries'] });
    const d = diffPlan(h.db, draft, '2026-10', TODAY);
    expect(d.retires).toMatchObject([{ name: 'Manicure', moveToName: 'Groceries', canRetire: true, reason: null }]);
    expect(d.retires[0].leftoverCents).toBe(left);
    expect(d.rows.find((r) => r.name === 'Manicure')).toMatchObject({ oldCents: 12500, newCents: 0 });
    const gBefore = categoryBalance(h.db, h.cats['Groceries'], TODAY).total!;
    makeLive(h.db, draft, { effectiveMonth: '2026-10', today: TODAY });
    expect((h.db.prepare('SELECT status, retired_month FROM categories WHERE id=?').get(h.cats['Manicure']) as any)).toEqual({ status: 'retired', retired_month: '2026-10' });
    expect(categoryBalance(h.db, h.cats['Manicure'], TODAY).total).toBe(0);
    expect(categoryBalance(h.db, h.cats['Groceries'], TODAY).total).toBe(gBefore + left);
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('a retirement is blocked when the envelope is overspent, and when the go-live month is still in the future', () => {
    const { h, draft } = scene();
    addPlanAction(h.db, draft, { kind: 'retire', categoryId: h.cats['Fees and Taxes'] });
    h.db.prepare('UPDATE categories SET start_month=? WHERE id=?').run('2026-10', h.cats['Fees and Taxes']);
    h.db.prepare("INSERT INTO transactions(account_id, occurred_on, amount_cents, kind, status) VALUES (?,?,?,?,?)").run(h.chase, '2026-10-02', -500000, 'spending', 'posted');
    const tid = (h.db.prepare('SELECT MAX(id) id FROM transactions').get() as any).id;
    h.db.prepare("INSERT INTO transaction_splits(transaction_id, category_id, amount_cents, origin) VALUES (?,?,?, 'user')").run(tid, h.cats['Fees and Taxes'], -500000);
    const d = diffPlan(h.db, draft, '2026-10', TODAY);
    expect(d.retires[0].canRetire).toBe(false);
    expect(d.blockers.join(' ')).toMatch(/Fees and Taxes/);
    expect(() => makeLive(h.db, draft, { effectiveMonth: '2026-10', today: TODAY })).toThrow(/Cannot|retire/i);
    // future month: retiring would take effect immediately, so it is refused with that reason
    const s = scene();
    addPlanAction(s.h.db, s.draft, { kind: 'retire', categoryId: s.h.cats['Manicure'] });
    const f = diffPlan(s.h.db, s.draft, '2026-12', TODAY);
    expect(f.blockers.join(' ')).toMatch(/Manicure.*(current|past|already)/i);
    expect(() => makeLive(s.h.db, s.draft, { effectiveMonth: '2026-12', today: TODAY })).toThrow();
    expect((s.h.db.prepare('SELECT status FROM categories WHERE id=?').get(s.h.cats['Manicure']) as any).status).toBe('active');
  });

  it('a blocked go-live changes nothing (atomic)', () => {
    const { h, draft } = scene();
    addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Eating Out'], cents: 1000 });
    addPlanAction(h.db, draft, { kind: 'retire', categoryId: h.cats['Manicure'] });
    setPlanItem(h.db, draft, h.cats['Groceries'], 1);
    expect(() => makeLive(h.db, draft, { effectiveMonth: '2026-12', today: TODAY })).toThrow();
    expect(currentAllocation(h.db, '2026-12').byCategory[h.cats['Groceries']]).toBe(80000);
    expect(h.db.prepare("SELECT COUNT(*) n FROM envelope_transfers WHERE kind='manual'").get()).toEqual({ n: 0 });
    expect((h.db.prepare('SELECT status FROM budget_plans WHERE id=?').get(draft) as any).status).toBe('draft');
  });

  it('actions can be removed, are kept (read-only) after go-live, and are not copied into a clone', () => {
    const { h, draft } = scene();
    const a = addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 100 });
    const b = addPlanAction(h.db, draft, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 200 });
    removePlanAction(h.db, draft, a);
    expect(planActions(h.db, draft).map((x) => x.id)).toEqual([b]);
    makeLive(h.db, draft, { effectiveMonth: '2026-10', today: TODAY });
    expect(planActions(h.db, draft)).toHaveLength(1);
    expect(() => removePlanAction(h.db, draft, b)).toThrow(/draft/);
    const clone = createPlan(h.db, 'Clone', { planId: draft }, '2026-10');
    expect(planActions(h.db, clone)).toEqual([]); // one-time events are not replayed by a copy
  });

  it('planDetail groups items by category group and reports the phase', () => {
    const { h, draft } = scene();
    const d = planDetail(h.db, draft, TODAY);
    expect(d.phase).toBe('draft');
    expect(d.items.find((i: any) => i.name === 'Groceries')).toMatchObject({ group_name: 'Food', monthly_cents: 80000 });
    expect(d.actions).toEqual([]);
  });
});
