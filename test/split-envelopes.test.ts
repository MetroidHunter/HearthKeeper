import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { createTransaction } from '../src/core/transactions.js';
import { categoryBalance } from '../src/core/balance.js';

const H = { 'x-requested-with': 'hearthkeeper' };

describe('split transactions count toward every envelope', () => {
  it('a $30 spend split $10/$20 lowers both envelopes through the API', async () => {
    const h = seedHousehold();
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    const today = '2026-10-19';
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: today, amountCents: -3000, descriptor: 'TARGET' });
    const g0 = categoryBalance(h.db, h.cats['Groceries'], today).total!, e0 = categoryBalance(h.db, h.cats['Eating Out'], today).total!;
    const r = await app.inject({ method: 'POST', url: `/api/transactions/${id}/categorize`, headers: H, payload: { splits: [{ categoryId: h.cats['Groceries'], amountCents: -1000 }, { categoryId: h.cats['Eating Out'], amountCents: -2000 }] } });
    expect(r.statusCode).toBe(200);
    expect(categoryBalance(h.db, h.cats['Groceries'], today).total).toBe(g0 - 1000);
    expect(categoryBalance(h.db, h.cats['Eating Out'], today).total).toBe(e0 - 2000);
    const page = (await app.inject({ method: 'GET', url: `/api/budget?today=${today}`, headers: H })).json();
    const row = (n: string) => page.rows.find((x: any) => x.name === n);
    expect(row('Groceries').currentCents).toBe(g0 - 1000);
    expect(row('Eating Out').currentCents).toBe(e0 - 2000);
  });
});
