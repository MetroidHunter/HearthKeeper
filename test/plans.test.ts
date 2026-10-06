import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createScenario, scenarioMonthlyNet, lineMetrics, cloneScenario, setScenarioLines } from '../src/core/earnings.js';
import { createPlan, setPlanItem, assignScenario, diffPlan, makeLive, planHeader } from '../src/core/plans.js';
import { categoryBalance, checkInvariants, currentAllocation } from '../src/core/balance.js';
import { budgetHistory } from '../src/core/categories.js';
import { proposeRebalance, commitRebalance, placePool, adjustment } from '../src/core/transfers.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { monthsOverview } from '../src/core/months.js';

describe('earnings', () => {
  it('matches the Projection worked example: $220k @ 100% @ 32% => $12,466.67/mo', () => {
    expect(lineMetrics({ label: 'Brys', annualSalaryCents: 22000000, taxRateBp: 3200 })).toMatchObject({ netAnnual: 14960000, monthlyNet: 1246667 });
    expect(lineMetrics({ label: 'old', annualSalaryCents: 3072000, workTimeBp: 9200, taxRateBp: 3150 }).netAnnual).toBe(1935974);
  });
  it('one-time lines are excluded; clone is independent', () => {
    const h = seedHousehold();
    const s = createScenario(h.db, 'A', [{ person: 'Brys', label: 'Salary', annualSalaryCents: 22000000, taxRateBp: 3200 }, { label: 'Bonus', annualSalaryCents: 2508000, taxRateBp: 3200, recurring: false }]);
    expect(scenarioMonthlyNet(h.db, s)).toBe(1246667);
    const c = cloneScenario(h.db, s, 'B');
    setScenarioLines(h.db, c, [{ label: 'x', annualSalaryCents: 24000000, taxRateBp: 3200 }]);
    expect(scenarioMonthlyNet(h.db, s)).toBe(1246667);
  });
});

describe('plans', () => {
  it('diff -> go live is atomic, snapshots income, archives previous, records history', () => {
    const h = seedHousehold();
    const sc = createScenario(h.db, 'S1', [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
    const p1 = createPlan(h.db, 'Initial', { livePlan: true }, '2026-10');
    assignScenario(h.db, p1, sc);
    makeLive(h.db, p1, { effectiveMonth: '2026-10', today: '2026-10-04' });
    expect((h.db.prepare('SELECT status, income_snapshot_cents s FROM budget_plans WHERE id=?').get(p1) as any)).toEqual({ status: 'live', s: 1246667 });
    const sc2 = cloneScenario(h.db, sc, 'After raise');
    setScenarioLines(h.db, sc2, [{ label: 'x', annualSalaryCents: 24000000, taxRateBp: 3200 }]);
    const p2 = createPlan(h.db, 'After raise', { livePlan: true }, '2026-10');
    assignScenario(h.db, p2, sc2);
    setPlanItem(h.db, p2, h.cats['Groceries'], 90000);
    setPlanItem(h.db, p2, h.cats['Eating Out'], 35000);
    const d = diffPlan(h.db, p2, '2026-10', '2026-10-04');
    expect(d.rows.map((r) => [r.name, r.oldCents, r.newCents])).toEqual([['Eating Out', 30000, 35000], ['Groceries', 80000, 90000]]);
    expect(d.historyEntries).toBe(2);
    makeLive(h.db, p2, { effectiveMonth: '2026-10', today: '2026-10-04' });
    expect((h.db.prepare("SELECT id FROM budget_plans WHERE status='live'").all() as any[]).map((r) => r.id)).toEqual([p2]);
    expect((h.db.prepare('SELECT status FROM budget_plans WHERE id=?').get(p1) as any).status).toBe('archived');
    expect(budgetHistory(h.db, h.cats['Groceries']).at(-1)).toMatchObject({ from_cents: 80000, monthly_cents: 90000, plan_id: p2 });
    expect(planHeader(h.db, p2).incomeCents).toBe(Math.round(((24000000 * 6800) / 10000) / 12));
    // revert = another go-live of the archived snapshot, itself diffed and audited
    makeLive(h.db, p1, { effectiveMonth: '2026-11', today: '2026-10-04' });
    expect(currentAllocation(h.db, '2026-11').byCategory[h.cats['Groceries']]).toBe(80000);
    expect((h.db.prepare('SELECT status FROM budget_plans WHERE id=?').get(p1) as any).status).toBe('archived'); // archive stays immutable
  });

  it('retroactive go-live requires explicit RESTATE and reports balance impact', () => {
    const h = seedHousehold();
    const p = createPlan(h.db, 'Retro', { livePlan: true }, '2026-10');
    setPlanItem(h.db, p, h.cats['Groceries'], 100000);
    const d = diffPlan(h.db, p, '2026-08', '2026-10-04');
    expect(d.retroactive).toBe(true);
    expect(d.rows[0].restatedBalanceDeltaCents).toBe(3 * 20000); // Aug, Sep, Oct each +$200
    expect(() => makeLive(h.db, p, { effectiveMonth: '2026-08', today: '2026-10-04' })).toThrow(/RESTATE/);
    const before = categoryBalance(h.db, h.cats['Groceries'], '2026-10-04').total!;
    makeLive(h.db, p, { effectiveMonth: '2026-08', today: '2026-10-04', confirmRestate: 'RESTATE' });
    expect(categoryBalance(h.db, h.cats['Groceries'], '2026-10-04').total! - before).toBe(60000);
  });

  it('only draft plans are editable and only active categories allowed', () => {
    const h = seedHousehold();
    const p = createPlan(h.db, 'x', 'blank', '2026-10');
    makeLive(h.db, p, { effectiveMonth: '2026-10', today: '2026-10-04' });
    expect(() => setPlanItem(h.db, p, h.cats['Groceries'], 1)).toThrow(/draft/);
  });
});

describe('rebalance and close', () => {
  it('pool pays overages first in priority order, then donors; legs sum to zero; remainder placed by hand', () => {
    const h = seedHousehold();
    const set = (name: string, extra: string) => h.db.prepare(`UPDATE categories SET ${extra} WHERE name=?`).run(name);
    set('Groceries', 'overage_priority=1'); set('Eating Out', 'overage_priority=2');
    const spend = (cat: string, cents: number) => { const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: cents }); setSplits(h.db, t, [{ categoryId: h.cats[cat], amountCents: cents }]); };
    const earn = (cat: string, cents: number) => { const t = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-10-03', amountCents: cents }); setSplits(h.db, t, [{ categoryId: h.cats[cat], amountCents: cents }]); };
    // As of 2026-10: Groceries accrued 9 mo * 800 = 7200; overspend to -150; Eating Out 2700 -> -100; Manicure 1125 (surplus)
    spend('Groceries', -(10 * 80000) - 15000);
    spend('Eating Out', -(10 * 30000) - 10000);
    earn('Gig Income', 20000);
    const p = proposeRebalance(h.db, '2026-10-31');
    expect(p.poolPayments).toEqual([{ poolCategoryId: h.cats['Gig Income'], toCategoryId: h.cats['Groceries'], cents: 15000 }, { poolCategoryId: h.cats['Gig Income'], toCategoryId: h.cats['Eating Out'], cents: 5000 }]);
    expect(p.donorMoves.every((m) => m.toCategoryId === h.cats['Eating Out'])).toBe(true);
    expect(p.donorMoves.reduce((a, m) => a + m.cents, 0)).toBe(5000);
    expect(p.remainingShortfall).toEqual([]);
    commitRebalance(h.db, p);
    for (const c of ['Groceries', 'Eating Out']) expect(categoryBalance(h.db, h.cats[c], '2026-10-31').total).toBe(0);
    expect(categoryBalance(h.db, h.cats['Gig Income'], '2026-10-31').total).toBe(0);
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('non-discretionary without cushion is immune; with cushion only the excess moves', () => {
    const h = seedHousehold();
    h.db.prepare("UPDATE categories SET discretionary=0 WHERE name IN ('Family Support','Manicure')").run();
    h.db.prepare("UPDATE categories SET cushion_cents=100000 WHERE name='Family Support'").run(); // 10 mo * 400 -> 2600 donatable
    h.db.prepare("UPDATE categories SET discretionary=0 WHERE name='Miracle Spending'").run();
    const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -(10 * 30000) - 99999999 });
    setSplits(h.db, t, [{ categoryId: h.cats['Eating Out'], amountCents: -(10 * 30000) - 99999999 }]);
    const p = proposeRebalance(h.db, '2026-10-31');
    const from = (c: string) => p.donorMoves.filter((m) => m.fromCategoryId === h.cats[c]).reduce((a, m) => a + m.cents, 0);
    expect(from('Manicure')).toBe(0);
    expect(from('Miracle Spending')).toBe(0);
    expect(from('Family Support')).toBe(10 * 40000 - 100000);
    expect(p.remainingShortfall.length).toBe(1);
  });

  it('placement cannot exceed the pool; adjustments are single-leg', () => {
    const h = seedHousehold();
    const t = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-10-03', amountCents: 50000 });
    setSplits(h.db, t, [{ categoryId: h.cats['Gig Income'], amountCents: 50000 }]);
    expect(() => placePool(h.db, '2026-10-31', h.cats['Gig Income'], [{ categoryId: h.cats['Manicure'], cents: 60000 }])).toThrow();
    placePool(h.db, '2026-10-31', h.cats['Gig Income'], [{ categoryId: h.cats['Manicure'], cents: 30000 }, { categoryId: h.cats['Groceries'], cents: 20000 }]);
    expect(categoryBalance(h.db, h.cats['Gig Income'], '2026-10-31').total).toBe(0);
    adjustment(h.db, '2026-10-31', h.cats['Manicure'], -50000, 'zero out');
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('the month checklist flags uncategorized transactions in the month they are in', () => {
    const h = seedHousehold();
    createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -500, descriptor: 'MYSTERY' });
    createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-10-02', amountCents: -500, descriptor: 'MYSTERY' });
    const oct = monthsOverview(h.db, '2026-10-04')[0];
    expect(oct.month).toBe('2026-10'); expect(oct.items.find((i) => i.key === 'category')!.count).toBe(2);
    expect(oct.items.find((i) => i.key === 'dupes')).toBeDefined();
  });
});
