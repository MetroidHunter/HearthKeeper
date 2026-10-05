import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { inbox, transactionContext, uncategorized } from '../src/core/reports.js';
import { retireCategory, unretireCategory, setBudget } from '../src/core/categories.js';
import { categoryBalance } from '../src/core/balance.js';

const H = { 'x-requested-with': 'hearthkeeper' };
const app = (h: ReturnType<typeof seedHousehold>) => buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });

describe('inbox: counts are true counts and every item says why', () => {
  it('reports totals beyond the 200-row list limit and a reason per item', () => {
    const h = seedHousehold();
    for (let i = 0; i < 230; i++) createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: -100 - i, descriptor: `MYSTERY ${i}` });
    const f = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -500, descriptor: 'WEIRD' });
    h.db.prepare("UPDATE transactions SET flagged=1, flag_reason='???' WHERE id=?").run(f);
    const i = inbox(h.db, '2026-10-05');
    expect(i.counts.needsCategory).toBe(231);
    expect(i.needsCategory).toHaveLength(200);
    expect(i.counts.flagged).toBe(1);
    expect(i.counts.total).toBe(231); // the flagged one is also uncategorized: counted once
    expect(i.needsCategory[0].why).toMatch(/No rule or merchant history/);
    expect(i.flagged[0].why).toMatch(/"\?"?.*look at this later|"\?\?\?"/);
  });
});

describe('uncategorized envelope and transaction context', () => {
  it('sums what has no category and shrinks as items are categorized', () => {
    const h = seedHousehold();
    const a = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: -1200, descriptor: 'A' });
    createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: -800, descriptor: 'B' });
    expect(uncategorized(h.db)).toMatchObject({ count: 2, netCents: -2000 });
    setSplits(h.db, a, [{ categoryId: h.cats['Groceries'], amountCents: -1200 }]);
    expect(uncategorized(h.db)).toMatchObject({ count: 1, netCents: -800 });
  });
  it('returns neighbours on the same account in order, with the target marked', () => {
    const h = seedHousehold();
    const ids = [1, 2, 3, 4, 5].map((n) => createTransaction(h.db, { accountId: h.chase, occurredOn: `2026-10-0${n}`, amountCents: -100 * n, descriptor: `T${n}` }));
    const c = transactionContext(h.db, ids[2], 1, 1)!;
    expect(c.rows.map((r: any) => r.descriptor_raw)).toEqual(['T2', 'T3', 'T4']);
    expect(c.rows.find((r: any) => r.isTarget)!.id).toBe(ids[2]);
    expect(transactionContext(h.db, 99999)).toBeNull();
  });
});

describe('unretire', () => {
  it('brings a category back with its last non-zero amount and accrues again', () => {
    const h = seedHousehold();
    const c = h.cats['Groceries'];
    setBudget(h.db, c, 40000, '2026-01', { reason: 'legacy' });
    retireCategory(h.db, c, '2026-06', { actor: 'test' });
    const retired = categoryBalance(h.db, c, '2026-09-30').accrued;
    expect(unretireCategory(h.db, c, '2026-09', { actor: 'test' })).toEqual({ monthlyCents: 40000 });
    expect((h.db.prepare('SELECT status FROM categories WHERE id=?').get(c) as any).status).toBe('active');
    expect(categoryBalance(h.db, c, '2026-10-31').accrued - retired).toBe(80000); // September and October accrue again
    expect(() => unretireCategory(h.db, c, '2026-09')).toThrow(/not retired/);
  });
});

describe('API: paging, favorites, merchants search', () => {
  it('counts transactions for pagination with the same filters', async () => {
    const h = seedHousehold(); const a = app(h);
    for (let i = 0; i < 7; i++) createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: -100, descriptor: i < 3 ? `COFFEE ${i}` : `OTHER ${i}` });
    expect((await a.inject({ url: '/api/transactions/count' })).json().total).toBe(7);
    expect((await a.inject({ url: '/api/transactions/count?q=coffee' })).json().total).toBe(3);
    expect((await a.inject({ url: '/api/transactions?limit=2&offset=2' })).json()).toHaveLength(2);
  });
  it('favorites toggle per user and show up on the budget page', async () => {
    const h = seedHousehold(); const a = app(h);
    h.db.prepare("INSERT INTO users(name,email) VALUES ('Brys','b@x.com')").run();
    await a.inject({ method: 'POST', url: '/api/favorites', headers: H, payload: { categoryId: h.cats['Groceries'] } });
    const rows = (await a.inject({ url: '/api/budget' })).json().rows;
    expect(rows.find((r: any) => r.name === 'Groceries').favorite).toBe(true);
    await a.inject({ method: 'DELETE', url: `/api/favorites/${h.cats['Groceries']}`, headers: H });
    expect((await a.inject({ url: '/api/budget' })).json().rows.find((r: any) => r.name === 'Groceries').favorite).toBe(false);
  });
  it('merchants are paged and searchable', async () => {
    const h = seedHousehold(); const a = app(h);
    for (let i = 0; i < 120; i++) h.db.prepare("INSERT INTO merchants(name, review_state) VALUES (?, 'reviewed')").run(`Shop ${i}`);
    h.db.prepare("INSERT INTO merchants(name, review_state) VALUES ('Zed Cafe','unreviewed')").run();
    const p1 = (await a.inject({ url: '/api/merchants?limit=50' })).json();
    expect(p1.rows).toHaveLength(50); expect(p1.total).toBe(121); expect(p1.unreviewed).toBe(1); expect(p1.rows[0].name).toBe('Zed Cafe');
    expect((await a.inject({ url: '/api/merchants?q=shop 11' })).json().rows.length).toBeGreaterThan(0);
  });
});
