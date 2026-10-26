import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { addCategory, budgetHistory, retireCategory, setBudget, unretireCategory } from '../src/core/categories.js';
import { categoryBalance, checkInvariants, currentAllocation } from '../src/core/balance.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { addRule } from '../src/core/rules.js';
import { createPlan, diffPlan, makeLive, setPlanItem } from '../src/core/plans.js';
import { budgetPage } from '../src/core/reports.js';

const H = { 'x-requested-with': 'hearthkeeper' };
const TODAY = '2026-10-15';
const app = (h: ReturnType<typeof seedHousehold>) => buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, now: () => TODAY });
const post = (a: ReturnType<typeof app>, url: string, payload: unknown) => a.inject({ method: 'POST', url, headers: H, payload: payload as any });
const spend = (h: ReturnType<typeof seedHousehold>, cat: string, cents: number, on = '2026-10-03') => {
  const id = createTransaction(h.db, { accountId: h.chase, occurredOn: on, amountCents: -cents, descriptor: `SPEND ${cat} ${cents}` });
  setSplits(h.db, id, [{ categoryId: h.cats[cat], amountCents: -cents }]);
};
const rule = (h: ReturnType<typeof seedHousehold>, text: string, category: string) =>
  addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: text }] }, action: { type: 'categorize', category }, mode: 'auto' });

describe('adding a category', () => {
  it('needs no money: it has no budget history until a budget is set', async () => {
    const h = seedHousehold(); const a = app(h);
    const r = await post(a, '/api/categories', { name: 'Hobbies', group: 'Fun', startMonth: '2026-10' });
    expect(r.statusCode).toBe(200);
    expect(budgetHistory(h.db, r.json().id)).toEqual([]);
  });
  it('a name that already exists is a plain 400 that says so (not "internal error"), whatever its case', async () => {
    const h = seedHousehold(); const a = app(h);
    for (const name of ['Groceries', 'groceries', '  GROCERIES ']) {
      const r = await post(a, '/api/categories', { name, startMonth: '2026-10' });
      expect(r.statusCode, name).toBe(400);
      expect(r.json().error).toMatch(/"Groceries" already exists/);
    }
  });
  it('says when the clash is with a retired category, so the fix (unretire) is obvious', async () => {
    const h = seedHousehold(); const a = app(h);
    retireCategory(h.db, h.cats['Manicure'], '2026-10');
    const r = await post(a, '/api/categories', { name: 'Manicure', startMonth: '2026-10' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/already exists/); expect(r.json().error).toMatch(/retired/i); expect(r.json().error).toMatch(/unretire/i);
  });
  it('a blank name is refused with a readable message', async () => {
    const r = await post(app(seedHousehold()), '/api/categories', { name: '   ', startMonth: '2026-10' });
    expect(r.statusCode).toBe(400); expect(r.json().error).toMatch(/name is required/i);
  });
});

describe('Budget page lists only envelopes that are in the plan', () => {
  const names = (h: ReturnType<typeof seedHousehold>) => budgetPage(h.db, TODAY).rows.map((r) => r.name);
  it('a new category stays off until a budget is set for it', () => {
    const h = seedHousehold();
    const id = addCategory(h.db, { name: 'Hobbies', group: 'Fun', startMonth: '2026-10' });
    expect(names(h)).not.toContain('Hobbies');
    setBudget(h.db, id, 2500, '2026-10');
    expect(names(h)).toContain('Hobbies');
  });
  it('a category with a $0 plan amount and no history is also off; one that has seen money is on', () => {
    const h = seedHousehold();
    const quiet = addCategory(h.db, { name: 'Quiet', startMonth: '2026-10' });
    const busy = addCategory(h.db, { name: 'Busy', startMonth: '2026-10' });
    h.cats['Busy'] = busy;
    spend(h, 'Busy', 1500);
    expect(names(h)).not.toContain('Quiet'); void quiet;
    expect(names(h)).toContain('Busy'); // spending landed there: hiding it would hide real money
  });
  it('envelopes that already had budgets (even $0 now) stay', () => {
    const h = seedHousehold();
    setBudget(h.db, h.cats['Manicure'], 0, '2026-10');
    expect(names(h)).toContain('Manicure');
    expect(names(h)).toContain('Gig Income'); // pool with money history in the household seed
  });
});

describe('categories list shows what is in each envelope', () => {
  it('GET /api/categories carries balance_cents equal to the balance engine (null for reference categories)', async () => {
    const h = seedHousehold(); const a = app(h);
    spend(h, 'Groceries', 12345);
    const cats = (await a.inject({ url: '/api/categories' })).json();
    for (const c of cats.filter((c: any) => !c.system)) expect(c.balance_cents, c.name).toBe(categoryBalance(h.db, c.id, TODAY).total);
    expect(cats.find((c: any) => c.name === 'Salary').balance_cents).toBeNull();
  });
});

describe('retire', () => {
  it('refuses an envelope with a negative balance, and says how much it is over', async () => {
    const h = seedHousehold(); const a = app(h);
    spend(h, 'Manicure', 2_000_000); // far more than has accrued
    const bal = categoryBalance(h.db, h.cats['Manicure'], TODAY).total!;
    expect(bal).toBeLessThan(0);
    const r = await post(a, `/api/categories/${h.cats['Manicure']}/retire`, {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/cannot retire/i); expect(r.json().error).toMatch(/overspent|negative/i);
    expect((h.db.prepare('SELECT status FROM categories WHERE id=?').get(h.cats['Manicure']) as any).status).toBe('active');
    expect(() => retireCategory(h.db, h.cats['Manicure'], '2026-10')).toThrow(/cannot retire/i);
  });
  it('an envelope at exactly zero, or above, can retire', () => {
    const h = seedHousehold();
    expect(() => retireCategory(h.db, h.cats['Groceries'], '2026-10')).not.toThrow();
    const z = addCategory(h.db, { name: 'Empty', startMonth: '2026-10' });
    expect(() => retireCategory(h.db, z, '2026-10')).not.toThrow();
  });
  it('can turn off every rule that files into the category, and leaves other rules alone', async () => {
    const h = seedHousehold(); const a = app(h);
    const r1 = rule(h, 'NAILS ONE', 'Manicure'), r2 = rule(h, 'NAILS TWO', 'manicure'), other = rule(h, 'SAFEWAY', 'Groceries');
    const res = await post(a, `/api/categories/${h.cats['Manicure']}/retire`, { disableRules: true });
    expect(res.statusCode).toBe(200); expect(res.json().rulesDisabled).toBe(2);
    const en = (id: number) => (h.db.prepare('SELECT enabled FROM rules WHERE id=?').get(id) as any).enabled;
    expect([en(r1), en(r2), en(other)]).toEqual([0, 0, 1]);
  });
  it('leaves rules on unless asked', async () => {
    const h = seedHousehold(); const a = app(h);
    const r1 = rule(h, 'NAILS ONE', 'Manicure');
    await post(a, `/api/categories/${h.cats['Manicure']}/retire`, {});
    expect((h.db.prepare('SELECT enabled FROM rules WHERE id=?').get(r1) as any).enabled).toBe(1);
  });
  it('the category detail lists its rules with whether they are on', async () => {
    const h = seedHousehold(); const a = app(h);
    const r1 = rule(h, 'NAILS ONE', 'Manicure');
    h.db.prepare('UPDATE rules SET enabled=0 WHERE id=?').run(r1);
    const d = (await a.inject({ url: `/api/categories/${h.cats['Manicure']}` })).json();
    expect(d.rules).toHaveLength(1); expect(d.rules[0].enabled).toBe(0);
  });
  it('unretire can turn its rules back on', async () => {
    const h = seedHousehold(); const a = app(h);
    const r1 = rule(h, 'NAILS ONE', 'Manicure'), r2 = rule(h, 'NAILS TWO', 'Manicure');
    await post(a, `/api/categories/${h.cats['Manicure']}/retire`, { disableRules: true });
    const keep = await post(a, `/api/categories/${h.cats['Manicure']}/unretire`, {});
    expect(keep.json().rulesEnabled).toBe(0);
    const en = (id: number) => (h.db.prepare('SELECT enabled FROM rules WHERE id=?').get(id) as any).enabled;
    expect([en(r1), en(r2)]).toEqual([0, 0]); // not asked: still off
    await post(a, `/api/categories/${h.cats['Manicure']}/retire`, {});
    const back = await post(a, `/api/categories/${h.cats['Manicure']}/unretire`, { enableRules: true });
    expect(back.json().rulesEnabled).toBe(2);
    expect([en(r1), en(r2)]).toEqual([1, 1]);
  });
  it('moving the balance when retiring this month lands today, so the destination shows it straight away', async () => {
    const h = seedHousehold(); const a = app(h);
    const before = categoryBalance(h.db, h.cats['Eating Out'], TODAY).total!;
    const r = (await post(a, `/api/categories/${h.cats['Groceries']}/retire`, { moveBalanceTo: h.cats['Eating Out'] })).json();
    expect(r.remainingCents).toBeGreaterThan(0);
    expect(categoryBalance(h.db, h.cats['Eating Out'], TODAY).total).toBe(before + r.remainingCents);
    expect(categoryBalance(h.db, h.cats['Groceries'], TODAY).total).toBe(0);
  });
  it('the category detail previews a retirement: balance now, balance left, and whether it may go', async () => {
    const h = seedHousehold(); const a = app(h);
    const d = (await a.inject({ url: `/api/categories/${h.cats['Groceries']}` })).json();
    expect(d.retire).toMatchObject({ canRetire: true, reason: null, currentCents: categoryBalance(h.db, h.cats['Groceries'], TODAY).total });
    expect(d.retire.afterCents).toBe(d.retire.currentCents - 80000); // this month's budget stops
  });
  it('core functions take the same options', () => {
    const h = seedHousehold();
    const r1 = rule(h, 'NAILS ONE', 'Manicure');
    expect(retireCategory(h.db, h.cats['Manicure'], '2026-10', { disableRules: true }).rulesDisabled).toBe(1);
    expect(unretireCategory(h.db, h.cats['Manicure'], '2026-10', { enableRules: true }).rulesEnabled).toBe(1);
    expect((h.db.prepare('SELECT enabled FROM rules WHERE id=?').get(r1) as any).enabled).toBe(1);
  });
});

describe('transfers never commit $0', () => {
  it('a manual move of 0, a negative amount, nothing, or from an envelope to itself is refused', async () => {
    const h = seedHousehold(); const a = app(h);
    for (const cents of [0, -500, null, 1.5]) {
      const r = await post(a, '/api/transfers/manual', { from: h.cats['Groceries'], to: h.cats['Eating Out'], cents });
      expect(r.statusCode, String(cents)).toBe(400);
      expect(r.json().error).toMatch(/more than \$0/i);
    }
    const same = await post(a, '/api/transfers/manual', { from: h.cats['Groceries'], to: h.cats['Groceries'], cents: 500 });
    expect(same.statusCode).toBe(400); expect(same.json().error).toMatch(/different/i);
    expect(h.db.prepare('SELECT COUNT(*) n FROM envelope_transfers').get()).toEqual({ n: 0 });
    expect((await post(a, '/api/transfers/manual', { from: h.cats['Groceries'], to: h.cats['Eating Out'], cents: 500 })).statusCode).toBe(200);
  });
  it('placing a pool with nothing (or $0 rows) is refused', async () => {
    const h = seedHousehold(); const a = app(h);
    const r = await post(a, '/api/transfers/place-pool', { asOf: TODAY, poolCategoryId: h.cats['Gig Income'], allocations: [{ categoryId: h.cats['Groceries'], cents: 0 }] });
    expect(r.statusCode).toBe(400); expect(r.json().error).toMatch(/more than \$0/i);
    expect((await post(a, '/api/transfers/place-pool', { asOf: TODAY, poolCategoryId: h.cats['Gig Income'], allocations: [] })).statusCode).toBe(400);
  });
  it('a $0 write-off is refused too', async () => {
    const h = seedHousehold(); const a = app(h);
    const r = await post(a, '/api/transfers/adjustment', { categoryId: h.cats['Groceries'], cents: 0, reason: 'zero out' });
    expect(r.statusCode).toBe(400);
  });
});

/**
 * A live plan, a brand-new category, then a second plan that sets three old categories to $0 and gives their combined
 * amount to the new one. Run with money left in the old envelopes and with none.
 */
describe('plan swap: three old categories folded into a new one', () => {
  const OLD = ['Eating Out', 'Manicure', 'Miracle Spending'] as const;
  const month = '2026-10';
  function setup(spendCents: Record<string, number>) {
    const h = seedHousehold();
    const first = createPlan(h.db, 'Initial', { livePlan: true }, '2026-01');
    makeLive(h.db, first, { effectiveMonth: '2026-01', today: '2026-01-05', actor: 'test' });
    for (const [name, cents] of Object.entries(spendCents)) spend(h, name, cents);
    const hobby = addCategory(h.db, { name: 'Hobbies', group: 'Fun', startMonth: month });
    const before = Object.fromEntries([...OLD, 'Groceries'].map((n) => [n, categoryBalance(h.db, h.cats[n], TODAY).total!]));
    const total = () => (h.db.prepare("SELECT id FROM categories WHERE kind='expense'").all() as { id: number }[]).reduce((s, c) => s + categoryBalance(h.db, c.id, TODAY).total!, 0);
    return { h, hobby, before, total };
  }
  const combined = (h: ReturnType<typeof seedHousehold>) => OLD.reduce((s, n) => s + currentAllocation(h.db, month).byCategory[h.cats[n]], 0);

  for (const [label, spendCents] of [['with money left in the envelopes', { 'Eating Out': 4000, Manicure: 1000, 'Miracle Spending': 500 }], ['with the envelopes spent down to exactly nothing this month', null]] as const) {
    it(`goes live and the history reads correctly ${label}`, () => {
      const { h, hobby, before, total } = setup(spendCents ?? {});
      if (!spendCents) { // spend each old envelope down to exactly zero before the swap
        for (const n of OLD) spend(h, n, categoryBalance(h.db, h.cats[n], TODAY).total!);
        for (const n of OLD) expect(categoryBalance(h.db, h.cats[n], TODAY).total).toBe(0);
        Object.assign(before, Object.fromEntries(OLD.map((n) => [n, 0])));
      }
      const sum = combined(h);
      expect(sum).toBe(5000 + 12500 + 30000);
      const totalNow = total();

      const plan = createPlan(h.db, 'Fold into Hobbies', { livePlan: true }, month);
      for (const n of OLD) setPlanItem(h.db, plan, h.cats[n], 0);
      setPlanItem(h.db, plan, hobby, sum);
      const d = diffPlan(h.db, plan, month, TODAY);
      expect(d.rows.map((r) => [r.name, r.oldCents, r.newCents]).sort()).toEqual([['Eating Out', 30000, 0], ['Hobbies', 0, sum], ['Manicure', 12500, 0], ['Miracle Spending', 5000, 0]].sort());
      expect(d.allocatedNew).toBe(d.allocatedOld); // nothing more is being budgeted, only moved

      makeLive(h.db, plan, { effectiveMonth: month, today: TODAY, actor: 'test' });

      // history: each old category ends in a $0 entry from this plan; the new one starts at the combined amount from this plan
      for (const n of OLD) {
        const hist = budgetHistory(h.db, h.cats[n]);
        const last = hist[hist.length - 1];
        expect(last).toMatchObject({ effective_month: month, monthly_cents: 0, reason: 'plan: Fold into Hobbies' });
        expect(last.from_cents).toBe(currentAllocation(h.db, '2026-09').byCategory[h.cats[n]]);
        expect(last.plan_id).toBe(plan);
        expect(hist.length).toBeGreaterThanOrEqual(2);
      }
      const hh = budgetHistory(h.db, hobby);
      expect(hh).toHaveLength(1);
      expect(hh[0]).toMatchObject({ effective_month: month, monthly_cents: sum, from_cents: null, reason: 'plan: Fold into Hobbies', plan_id: plan });

      // allocation this month: old three are 0, Hobbies carries their total, the overall allocation did not move
      const alloc = currentAllocation(h.db, month);
      for (const n of OLD) expect(alloc.byCategory[h.cats[n]]).toBe(0);
      expect(alloc.byCategory[hobby]).toBe(sum);
      // and last month is untouched (the swap is not retroactive)
      for (const n of OLD) expect(currentAllocation(h.db, '2026-09').byCategory[h.cats[n]]).toBeGreaterThan(0);
      expect(currentAllocation(h.db, '2026-09').byCategory[hobby]).toBe(0);

      // balances: the old envelopes lose exactly this month's accrual, Hobbies gains the same; total money is conserved
      for (const n of OLD) expect(categoryBalance(h.db, h.cats[n], TODAY).total, n).toBe(before[n] - (n === 'Eating Out' ? 30000 : n === 'Manicure' ? 12500 : 5000));
      expect(categoryBalance(h.db, hobby, TODAY).total).toBe(sum);
      expect(categoryBalance(h.db, hobby, '2026-09-30').total).toBe(0);
      expect(total()).toBe(totalNow);
      expect(checkInvariants(h.db)).toEqual([]);

      // the Budget page: all four are listed (the old three have history), Hobbies shows its new target
      const rows = budgetPage(h.db, TODAY).rows;
      expect(rows.find((r) => r.name === 'Hobbies')).toMatchObject({ targetCents: sum, currentCents: sum });
      for (const n of OLD) expect(rows.find((r) => r.name === n)).toMatchObject({ targetCents: 0 });
    });
  }

  it('an envelope that still holds money keeps it after being set to $0 (nothing is swept), and can then retire with a transfer', () => {
    const { h, hobby } = setup({ 'Eating Out': 4000 });
    const plan = createPlan(h.db, 'Fold', { livePlan: true }, month);
    setPlanItem(h.db, plan, h.cats['Eating Out'], 0); setPlanItem(h.db, plan, hobby, 30000);
    makeLive(h.db, plan, { effectiveMonth: month, today: TODAY, actor: 'test' });
    const left = categoryBalance(h.db, h.cats['Eating Out'], TODAY).total!;
    expect(left).toBeGreaterThan(0);
    const r = retireCategory(h.db, h.cats['Eating Out'], month, { moveBalanceTo: hobby, asOf: TODAY });
    expect(r.remainingCents).toBe(left);
    expect(categoryBalance(h.db, h.cats['Eating Out'], TODAY).total).toBe(0);
    expect(categoryBalance(h.db, hobby, TODAY).total).toBe(30000 + left);
  });
});
