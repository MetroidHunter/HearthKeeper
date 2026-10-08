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
    const p = proposeRebalance(h.db, '2026-10-31', { topUp: false }); // just the overages (the top-up is tested below)
    expect(p.poolPayments).toEqual([{ poolCategoryId: h.cats['Gig Income'], toCategoryId: h.cats['Groceries'], cents: 15000 }, { poolCategoryId: h.cats['Gig Income'], toCategoryId: h.cats['Eating Out'], cents: 5000 }]);
    expect(p.donorMoves.every((m) => m.toCategoryId === h.cats['Eating Out'])).toBe(true);
    expect(p.donorMoves.reduce((a, m) => a + m.cents, 0)).toBe(5000);
    expect(p.remainingShortfall).toEqual([]);
    commitRebalance(h.db, p);
    for (const c of ['Groceries', 'Eating Out']) expect(categoryBalance(h.db, h.cats[c], '2026-10-31').total).toBe(0);
    expect(categoryBalance(h.db, h.cats['Gig Income'], '2026-10-31').total).toBe(0);
    expect(checkInvariants(h.db)).toEqual([]);
  });

  describe('overages are covered, then topped up with the budget for the days left in the month', () => {
    const scene = async (poolCents: number) => {
      const { addCategory } = await import('../src/core/categories.js');
      const h = seedHousehold();
      const bricks = addCategory(h.db, { name: 'Bricks', group: 'Home', startMonth: '2026-11', monthlyCents: 15000, kind: 'expense', overagePriority: 1 }); // $150 budget
      const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-11-02', amountCents: -22000, descriptor: 'BRICKS' }); // accrues $150, spends $220: -$70
      setSplits(h.db, t, [{ categoryId: bricks, amountCents: -22000 }]);
      if (poolCents) { const e = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-11-03', amountCents: poolCents, descriptor: 'GIG' }); setSplits(h.db, e, [{ categoryId: h.cats['Gig Income'], amountCents: poolCents }]); }
      return { h, bricks };
    };
    const noDonors = (h: ReturnType<typeof seedHousehold>, ...except: number[]) => h.db.prepare(`UPDATE categories SET cushion_cents=999999999 WHERE id NOT IN (${except.map(() => '?').join(',')})`).run(...except);
    it('Bricks at -$70 with a $150 budget on day 11 of 30 is asked to receive $70 + $150 × 19/30 = $165', async () => {
      const { h, bricks } = await scene(50000);
      const p = proposeRebalance(h.db, '2026-11-11');
      expect(p.poolPayments).toEqual([{ poolCategoryId: h.cats['Gig Income'], toCategoryId: bricks, cents: 7000 + 9500 }]);
      expect(p.topUps).toEqual([{ categoryId: bricks, wantedCents: 9500, fundedCents: 9500, day: 11, days: 30, remaining: 19, monthlyCents: 15000 }]);
      expect(p.remainingShortfall).toEqual([]);
      expect(p.resulting[bricks]).toBe(9500); // ends the proposal holding the budget for the 19 days that remain
      commitRebalance(h.db, p); expect(categoryBalance(h.db, bricks, '2026-11-11').total).toBe(9500); expect(checkInvariants(h.db)).toEqual([]);
    });
    it('can be switched off: then only the overage is covered', async () => {
      const { h, bricks } = await scene(50000);
      const p = proposeRebalance(h.db, '2026-11-11', { topUp: false });
      expect(p.poolPayments).toEqual([{ poolCategoryId: h.cats['Gig Income'], toCategoryId: bricks, cents: 7000 }]); expect(p.topUps).toEqual([]);
    });
    it('a top-up only uses what is left after every overage is covered; unfunded top-up is reported but is not a shortfall', async () => {
      const { h, bricks } = await scene(8000); // enough for the $70 and $10 of the $95
      noDonors(h, bricks);
      const p = proposeRebalance(h.db, '2026-11-11');
      expect(p.poolPayments[0].cents).toBe(8000); expect(p.remainingShortfall).toEqual([]);
      expect(p.topUps[0]).toMatchObject({ wantedCents: 9500, fundedCents: 1000 });
      const small = await scene(5000); // not even the overage
      noDonors(small.h, small.bricks);
      const q = proposeRebalance(small.h.db, '2026-11-11');
      expect(q.remainingShortfall).toEqual([{ categoryId: small.bricks, cents: 2000 }]); expect(q.topUps[0].fundedCents).toBe(0);
    });
    it('donors give for the top-up too, but never below their own budget + cushion', async () => {
      const { h, bricks } = await scene(0);
      h.db.prepare("UPDATE categories SET cushion_cents=999999999 WHERE id NOT IN (?, ?)").run(bricks, h.cats['Manicure']); // only Manicure ($125 budget) can give
      const p = proposeRebalance(h.db, '2026-11-11');
      expect(p.donorMoves).toEqual([{ fromCategoryId: h.cats['Manicure'], toCategoryId: bricks, cents: 16500 }]); // $70 + $95
      h.db.prepare("UPDATE categories SET cushion_cents=(11*12500 - 12500 - 9000) WHERE id=?").run(h.cats['Manicure']); // leaves only $90 above its floor (budget + cushion)
      expect(proposeRebalance(h.db, '2026-11-11').donorMoves.reduce((a, m) => a + m.cents, 0)).toBe(9000);
    });
    it('two overspent envelopes: both overages are covered in priority order before either gets a top-up', async () => {
      const { addCategory } = await import('../src/core/categories.js');
      const { h, bricks } = await scene(0);
      const tiles = addCategory(h.db, { name: 'Tiles', group: 'Home', startMonth: '2026-11', monthlyCents: 15000, kind: 'expense', overagePriority: 2 });
      const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-11-02', amountCents: -25000, descriptor: 'TILES' }); setSplits(h.db, t, [{ categoryId: tiles, amountCents: -25000 }]); // -$100
      const e = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-11-03', amountCents: 20000, descriptor: 'GIG' }); setSplits(h.db, e, [{ categoryId: h.cats['Gig Income'], amountCents: 20000 }]);
      noDonors(h, bricks, tiles);
      const p = proposeRebalance(h.db, '2026-11-11');
      const to = (id: number) => p.poolPayments.filter((m) => m.toCategoryId === id).reduce((a, m) => a + m.cents, 0);
      expect(to(tiles)).toBe(10000);                       // Tiles' overage is fully covered even though Bricks has higher priority
      expect(to(bricks)).toBe(7000 + 3000);                // Bricks: its overage, and the remaining $30 toward its top-up
      expect(p.topUps.find((x) => x.categoryId === tiles)!.fundedCents).toBe(0);
    });
  });

  it('non-discretionary envelopes never give, whatever they hold or whatever their cushion; only discretionary ones above budget + cushion do', () => {
    const h = seedHousehold();
    h.db.prepare("UPDATE categories SET discretionary=0 WHERE name IN ('Family Support','Manicure','Miracle Spending')").run();
    h.db.prepare("UPDATE categories SET cushion_cents=0 WHERE name IN ('Family Support','Manicure')").run(); // even an explicit cushion of 0 does not make them donors
    const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -(10 * 30000) - 99999999 });
    setSplits(h.db, t, [{ categoryId: h.cats['Eating Out'], amountCents: -(10 * 30000) - 99999999 }]);
    const p = proposeRebalance(h.db, '2026-10-31');
    const from = (c: string) => p.donorMoves.filter((m) => m.fromCategoryId === h.cats[c]).reduce((a, m) => a + m.cents, 0);
    for (const c of ['Family Support', 'Manicure', 'Miracle Spending']) expect(from(c), c).toBe(0);
    expect(p.donorMoves.length).toBeGreaterThan(0); // discretionary envelopes (Groceries) still give
    expect(p.donorMoves.every((m) => !['Family Support', 'Manicure', 'Miracle Spending'].some((n) => h.cats[n] === m.fromCategoryId))).toBe(true);
  });

  it('the cushion is the amount kept ABOVE the current monthly budget: $150 budget + $50 cushion means nothing moves until it holds more than $200', async () => {
    const { addCategory } = await import('../src/core/categories.js');
    const { keepFloor } = await import('../src/core/transfers.js');
    const h = seedHousehold();
    const bricks = addCategory(h.db, { name: 'Bricks', group: 'Home', startMonth: '2026-10', monthlyCents: 15000, kind: 'expense', cushionCents: 5000 });
    expect(keepFloor({ monthly: 15000, cushion_cents: 5000 })).toBe(20000); expect(keepFloor({ monthly: 15000, cushion_cents: null })).toBe(15000); expect(keepFloor({ monthly: 15000, cushion_cents: 0 })).toBe(15000); // empty is 0
    // nobody else can give anything; Eating Out is overspent by $150 in November (and by far more in October)
    h.db.prepare('UPDATE categories SET cushion_cents=999999999 WHERE id NOT IN (?, ?)').run(bricks, h.cats['Eating Out']);
    const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -345000, descriptor: 'BIG EATING OUT' });
    setSplits(h.db, t, [{ categoryId: h.cats['Eating Out'], amountCents: -345000 }]);
    const given = (asOf: string) => { const p = proposeRebalance(h.db, asOf); return { given: p.donorMoves.filter((m) => m.fromCategoryId === bricks).reduce((a, m) => a + m.cents, 0), short: p.remainingShortfall.reduce((a, x) => a + x.cents, 0) }; };
    expect(given('2026-10-31').given).toBe(0);            // Bricks holds $150, the budget itself: below budget + cushion ($200)
    expect(given('2026-11-30')).toMatchObject({ given: 10000 }); // $300 held: only the $100 above $200 may move, although $150 is needed
    expect(given('2026-11-30').short).toBeGreaterThan(0);
    h.db.prepare('UPDATE categories SET cushion_cents=0 WHERE id=?').run(bricks);
    expect(given('2026-11-30').given).toBe(15000);        // a cushion of 0 still keeps this month's budget ($150), so $150 may move
    h.db.prepare('UPDATE categories SET cushion_cents=NULL WHERE id=?').run(bricks);
    expect(given('2026-11-30').given).toBe(15000);        // empty counts as 0: the same as a cushion of 0
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
