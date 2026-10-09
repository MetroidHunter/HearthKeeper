import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { setBudget } from '../src/core/categories.js';
import { createTransfer } from '../src/core/transfers.js';
import { categoryBalance } from '../src/core/balance.js';
import { weeksOfMonth, createWeekly, updateWeekly, deleteWeekly, listWeekly, setWeeklyFavorite } from '../src/core/weekly.js';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/core/schema.js';
import { migrate } from '../src/core/db.js';
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
  h.db.prepare("UPDATE categories SET start_month='2026-10' WHERE id=?").run(h.cats['Eating Out']);   // starts this month, so nothing is carried in
  setBudget(h.db, h.cats['Eating Out'], 31000, '2026-01');    // $310 a month: $1,000 a day in October
  const id = createWeekly(h.db, { categoryId: h.cats['Eating Out'] }, 'system', '2026-10-01');
  return { h, spend, id };
};

describe('weekly budget', () => {
  it('shows what is left in each week and in the month; whatever is left carries into the next week, over or under', () => {
    const { h, spend } = scene();
    spend('Eating Out', '2026-10-02', 3000);     // week 1: $40 → $10 left, which carries
    spend('Eating Out', '2026-10-06', 9500);     // week 2: $70 + $10 − $95 = −$15
    spend('Groceries', '2026-10-07', 50000);     // some other category
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
  it('starts from what the envelope held when the month began, so its total always agrees with the envelope', () => {
    const { h, spend } = scene();
    h.db.prepare("UPDATE categories SET start_month='2026-08' WHERE id=?").run(h.cats['Eating Out']);   // Aug, Sep: $620 accrued before October
    spend('Eating Out', '2026-08-20', 8000);                        // $80 spent earlier: $540 carried into October
    spend('Eating Out', '2026-10-02', 3000);
    spend('Eating Out', '2026-10-06', 9500);
    createTransfer(h.db, 'manual', '2026-10-07', [{ categoryId: h.cats['Eating Out'], cents: 2500 }, { categoryId: h.cats['Groceries'], cents: -2500 }]);   // $25 covered in
    for (const today of ['2026-10-01', '2026-10-08', '2026-10-31']) {
      const [b] = listWeekly(h.db, today);
      expect(b.remainingCents).toBe(categoryBalance(h.db, h.cats['Eating Out'], today).total);              // the number the Budget page shows for the envelope
    }
    const [b] = listWeekly(h.db, '2026-10-31');
    expect(b.weeks[0].carriedCents).toBe(54000 + 2500);                                                       // what the envelope held on September 30, plus the month's $25 transfer
    expect(b.weeks.map((w) => w.remainingCents)).toEqual([56500 + 4000 - 3000, 57500 + 7000 - 9500, 55000 + 7000, 62000 + 7000, 69000 + 6000]);   // the transfer does not pose as week 2's money
    expect(b.weeks.at(-1)!.remainingCents).toBe(b.remainingCents);
    expect(b.remainingCents).toBe(75000);                                                                     // 3 × 310 − 80 − 30 − 95 + 25 = $750
    expect(listWeekly(h.db, '2026-10-08')[0].remainingCents).toBe(categoryBalance(h.db, h.cats['Eating Out'], '2026-10-08').total);
  });
  it('an overspent envelope that is covered mid-month does not show a deficit in the weeks before the coverage', () => {
    const { h, spend } = scene();
    h.db.prepare("UPDATE categories SET start_month='2026-08' WHERE id=?").run(h.cats['Eating Out']);
    spend('Eating Out', '2026-08-20', 100000);                      // $1,000 spent against $620 accrued: the envelope entered October at -$380
    spend('Eating Out', '2026-10-02', 3000);
    createTransfer(h.db, 'manual', '2026-10-06', [{ categoryId: h.cats['Eating Out'], cents: 40000 }, { categoryId: h.cats['Groceries'], cents: -40000 }]);   // covered with $400 in week 2
    const [b] = listWeekly(h.db, '2026-10-08');
    expect(b.weeks[0].remainingCents).toBe(-38000 + 40000 + 4000 - 3000);                                   // $30 left, not -$380 until the coverage arrives
    expect(b.weeks.every((w) => w.remainingCents > 0)).toBe(true);
    expect(b.remainingCents).toBe(categoryBalance(h.db, h.cats['Eating Out'], '2026-10-08').total);
  });
  it('is named after its category, takes its total from the category budget, and follows it when that changes', () => {
    const { h } = scene();
    expect(listWeekly(h.db, '2026-10-14')[0]).toMatchObject({ name: 'Eating Out Weekly', category: 'Eating Out', amountCents: 31000 });
    setBudget(h.db, h.cats['Eating Out'], 62000, '2026-10');
    expect(listWeekly(h.db, '2026-10-14')[0].weeks.map((w) => w.allottedCents)).toEqual([8000, 14000, 14000, 14000, 12000]);
    expect(listWeekly(h.db, '2026-09-14')[0].amountCents).toBe(31000);                   // earlier months keep what the budget was then
    expect(listWeekly(h.db, '2026-10-14', { month: '2026-09' })[0].amountCents).toBe(31000);
  });
  it('validates, edits, deletes, and keeps per-person favorites', () => {
    const { h, id } = scene();
    const bad = (o: object, msg: RegExp) => expect(() => createWeekly(h.db, { categoryId: h.cats['Groceries'], ...o }, 'system', '2026-10-01')).toThrow(msg);
    bad({ categoryId: h.cats['Salary'] }, /spending category/); bad({ categoryId: 99999 }, /spending category/); bad({ weekStart: 8 }, /week starts/);
    bad({ categoryId: h.cats['Eating Out'] }, /already has a weekly budget/);
    setBudget(h.db, h.cats['Manicure'], 0, '2026-01');
    bad({ categoryId: h.cats['Manicure'] }, /no monthly budget/);
    updateWeekly(h.db, id, { categoryId: h.cats['Groceries'], weekStart: 7 });
    expect(listWeekly(h.db, '2026-10-14')[0]).toMatchObject({ name: 'Groceries Weekly', amountCents: 80000, weekStart: 7 });
    expect(() => updateWeekly(h.db, 999, { categoryId: h.cats['Groceries'] })).toThrow();
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
    const body = { categoryId: h.cats['Eating Out'], weekStart: 1 };
    expect((await call('POST', '/api/weekly-budgets', { weekStart: 1 })).statusCode).toBe(400);
    const id = (await call('POST', '/api/weekly-budgets', body)).json().id;
    const list = (await call('GET', '/api/weekly-budgets')).json();
    expect(list).toHaveLength(1);
    expect(list[0].weeks).toHaveLength(5);
    expect(list[0].name).toBe('Eating Out Weekly');
    expect((await call('POST', '/api/weekly-budgets', body)).statusCode).toBe(400);   // one per category
    expect(list[0].currentWeek).toBe(3);
    const prev = (await call('GET', '/api/weekly-budgets/preview?month=2026-10&weekStart=7&amountCents=31000')).json();
    expect(prev[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-03' });
    expect((await call('PUT', `/api/weekly-budgets/${id}`, { categoryId: h.cats['Groceries'], weekStart: 2 })).statusCode).toBe(200);
    expect((await call('PUT', '/api/weekly-budgets/999', body)).statusCode).toBe(400);
    expect((await call('POST', `/api/weekly-budgets/${id}/favorite`)).statusCode).toBe(200);
    expect((await call('GET', '/api/weekly-budgets')).json()[0]).toMatchObject({ name: 'Groceries Weekly', weekStart: 2 });
    await call('DELETE', `/api/weekly-budgets/${id}`);
    expect((await call('GET', '/api/weekly-budgets')).json()).toEqual([]);
  });
});

describe('weekly budgets created before they were tied to one category', () => {
  it('keep their first category and week start, and their pins', () => {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE _migrations(id INTEGER PRIMARY KEY)');
    MIGRATIONS.slice(0, -1).forEach((sql, i) => { db.exec(sql); db.prepare('INSERT INTO _migrations(id) VALUES (?)').run(i); });
    db.exec(`INSERT INTO categories(id, name, kind, start_month) VALUES (1,'Food','expense','2026-01'),(2,'Fun','expense','2026-01');
      INSERT INTO users(id, name, email) VALUES (1,'Me','m@x.c');
      INSERT INTO weekly_budgets(id, name, amount_cents, week_start) VALUES (1,'Old one',30000,3),(2,'Empty',100,1);
      INSERT INTO weekly_budget_categories VALUES (1,2),(1,1),(2,1);
      INSERT INTO weekly_favorites VALUES (1,1),(1,2);`);
    migrate(db);
    expect(db.prepare('SELECT id, category_id, week_start FROM weekly_budgets ORDER BY id').all()).toEqual([{ id: 1, category_id: 1, week_start: 3 }]);   // the second one wanted a category already taken
    expect(db.prepare('SELECT user_id, weekly_id FROM weekly_favorites').all()).toEqual([{ user_id: 1, weekly_id: 1 }]);
  });
});
