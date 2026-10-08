import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { weeksOfMonth, createWeekly, updateWeekly, deleteWeekly, listWeekly, setWeeklyFavorite } from '../src/core/weekly.js';
import { buildApp } from '../src/server/app.js';

describe('weeks of a month', () => {
  it('cuts weeks at month ends: a short week starts the month and a short one ends it', () => {
    // October 2026 starts on a Thursday and ends on a Saturday; weeks start Monday
    const w = weeksOfMonth('2026-10', 1, 31000);
    expect(w.map((x) => [x.from, x.to, x.days])).toEqual([['2026-10-01', '2026-10-04', 4], ['2026-10-05', '2026-10-11', 7], ['2026-10-12', '2026-10-18', 7], ['2026-10-19', '2026-10-25', 7], ['2026-10-26', '2026-10-31', 6]]);
    expect(w.map((x) => x.allottedCents)).toEqual([4000, 7000, 7000, 7000, 6000]);       // by days: $1000 a day
    expect(w.map((x) => x.limitCents)).toEqual([4000, 11000, 18000, 25000, 31000]);       // the running thresholds
  });
  it('the weeks always add up to the month exactly, whatever the amount and week start', () => {
    for (const month of ['2026-02', '2028-02', '2026-10', '2026-12', '2027-05']) for (let ws = 1; ws <= 7; ws++) for (const amt of [1, 7, 10000, 33333, 100001]) {
      const w = weeksOfMonth(month, ws, amt);
      expect(w.reduce((a, x) => a + x.allottedCents, 0)).toBe(amt);
      expect(w.reduce((a, x) => a + x.days, 0)).toBe(Number(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()));
      expect(w.every((x, i) => (i === 0 || x.from > w[i - 1].to) && x.allottedCents >= 0)).toBe(true);
    }
  });
  it('a month that starts on the week start has no short first week', () => {
    const w = weeksOfMonth('2026-06', 1, 30000);   // June 1 2026 is a Monday
    expect(w[0]).toMatchObject({ from: '2026-06-01', to: '2026-06-07', days: 7 });
    expect(w.at(-1)).toMatchObject({ from: '2026-06-29', to: '2026-06-30', days: 2 });
  });
});

const scene = () => {
  const h = seedHousehold();
  const spend = (cat: string, day: string, cents: number) => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -cents, descriptor: 'X' }); setSplits(h.db, id, [{ categoryId: h.cats[cat], amountCents: -cents }]); return id; };
  const id = createWeekly(h.db, { name: 'Fun money', amountCents: 31000, categoryIds: [h.cats['Eating Out'], h.cats['Manicure']] });
  return { h, spend, id };
};

describe('weekly budget', () => {
  it('shows what is left in each week and in the month; whatever is left carries into the next week, over or under', () => {
    const { h, spend } = scene();
    spend('Eating Out', '2026-10-02', 3000);     // week 1: $40 → $10 left, which carries
    spend('Manicure', '2026-10-06', 9500);       // week 2: $70 + $10 − $95 = −$15
    spend('Groceries', '2026-10-07', 50000);     // not one of this budget's categories
    const [b] = listWeekly(h.db, '2026-10-14');
    expect(b.weeks.map((w) => w.spentCents)).toEqual([3000, 9500, 0, 0, 0]);
    expect(b.weeks.map((w) => w.carriedCents)).toEqual([0, 1000, -1500, 5500, 12500]);
    expect(b.weeks.map((w) => w.remainingCents)).toEqual([1000, -1500, 5500, 12500, 18500]);
    expect(b.weeks.map((w) => w.state)).toEqual(['past', 'past', 'current', 'future', 'future']);
    expect(b.currentWeek).toBe(3);
    expect(b.spentCents).toBe(12500);
    expect(b.remainingCents).toBe(31000 - 12500);
    expect(b.weeks.at(-1)!.remainingCents).toBe(b.remainingCents);     // the last week's remainder is the month's
  });
  it('an overage keeps eating into the following weeks until it is paid back', () => {
    const { h, spend } = scene();
    spend('Eating Out', '2026-10-06', 20000);    // week 2 is $130 over
    const [b] = listWeekly(h.db, '2026-10-30');
    expect(b.weeks.map((w) => w.remainingCents)).toEqual([4000, -9000, -2000, 5000, 11000]);
  });
  it('refunds count back, voided transactions and other months do not count', () => {
    const { h, spend } = scene();
    spend('Eating Out', '2026-10-06', 5000);
    const refund = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-07', amountCents: 2000, descriptor: 'REFUND' });
    setSplits(h.db, refund, [{ categoryId: h.cats['Eating Out'], amountCents: 2000 }]);
    const dead = spend('Eating Out', '2026-10-08', 9999); h.db.prepare("UPDATE transactions SET status='void' WHERE id=?").run(dead);
    spend('Eating Out', '2026-09-30', 7777);
    expect(refund).toBeGreaterThan(0);
    const [b] = listWeekly(h.db, '2026-10-14');
    expect(b.weeks[1].spentCents).toBe(3000);
    expect(b.spentCents).toBe(3000);
    expect(listWeekly(h.db, '2026-10-14', { month: '2026-09' })[0].spentCents).toBe(7777);
  });
  it('validates, edits, deletes, and keeps per-person favorites', () => {
    const { h, id } = scene();
    const bad = (o: object) => expect(() => createWeekly(h.db, { name: 'x', amountCents: 100, categoryIds: [h.cats['Groceries']], ...o })).toThrow();
    bad({ name: ' ' }); bad({ amountCents: 0 }); bad({ amountCents: 1.5 }); bad({ categoryIds: [] }); bad({ categoryIds: [h.cats['Salary']] }); bad({ categoryIds: [99999] }); bad({ weekStart: 8 });
    updateWeekly(h.db, id, { name: 'Dining', amountCents: 20000, categoryIds: [h.cats['Groceries']], weekStart: 7 });
    expect(listWeekly(h.db, '2026-10-14')[0]).toMatchObject({ name: 'Dining', amountCents: 20000, weekStart: 7, categories: ['Groceries'] });
    expect(() => updateWeekly(h.db, 999, { name: 'x', amountCents: 1, categoryIds: [h.cats['Groceries']] })).toThrow();
    h.db.prepare("INSERT INTO users(id, name, email) VALUES (7,'A','a@b.c')").run();
    setWeeklyFavorite(h.db, 7, id, true); setWeeklyFavorite(h.db, 7, id, true);
    expect(listWeekly(h.db, '2026-10-14', { userId: 7 })[0].favorite).toBe(true);
    expect(listWeekly(h.db, '2026-10-14', { userId: 8 })[0].favorite).toBe(false);
    expect(deleteWeekly(h.db, id)).toBe(true);
    expect(listWeekly(h.db, '2026-10-14')).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) n FROM weekly_favorites').get()).toEqual({ n: 0 });
    expect(deleteWeekly(h.db, id)).toBe(false);
  });
});

describe('weekly budget API', () => {
  const H = { 'x-requested-with': 'hearthkeeper' };
  it('creates, previews, lists, edits, favorites and deletes; bad input is a 400', async () => {
    const h = seedHousehold();
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, now: () => '2026-10-14' });
    h.db.prepare("INSERT INTO users(id, name, email) VALUES (1,'Me','me@x.com')").run();
    const call = (method: string, url: string, payload?: object) => app.inject({ method: method as any, url, headers: H, payload });
    const body = { name: 'Fun', amountCents: 31000, categoryIds: [h.cats['Eating Out']], weekStart: 1 };
    expect((await call('POST', '/api/weekly-budgets', { ...body, categoryIds: [] })).statusCode).toBe(400);
    const id = (await call('POST', '/api/weekly-budgets', body)).json().id;
    const list = (await call('GET', '/api/weekly-budgets')).json();
    expect(list).toHaveLength(1);
    expect(list[0].weeks).toHaveLength(5);
    expect(list[0].currentWeek).toBe(3);
    const prev = (await call('GET', '/api/weekly-budgets/preview?month=2026-10&weekStart=7&amountCents=31000')).json();
    expect(prev[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-03' });
    expect((await call('PUT', `/api/weekly-budgets/${id}`, { ...body, name: 'Fun 2'})).statusCode).toBe(200);
    expect((await call('PUT', '/api/weekly-budgets/999', body)).statusCode).toBe(400);
    expect((await call('POST', `/api/weekly-budgets/${id}/favorite`)).statusCode).toBe(200);
    expect((await call('GET', '/api/weekly-budgets')).json()[0]).toMatchObject({ name: 'Fun 2'});
    await call('DELETE', `/api/weekly-budgets/${id}`);
    expect((await call('GET', '/api/weekly-budgets')).json()).toEqual([]);
  });
});
