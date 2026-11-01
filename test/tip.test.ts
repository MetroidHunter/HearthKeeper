import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { seedHousehold } from './helpers.js';
import { createTransaction, setSplits, ignoreTransaction, setTip } from '../src/core/transactions.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';

const pending = (h: any, cents = -2000, desc = 'EL RINCONSITO', date = '2026-10-03') => createTransaction(h.db, { accountId: h.chase, occurredOn: date, amountCents: cents, descriptor: desc, status: 'provisional', authorizedAt: `${date}T18:00:00Z` });
const row = (h: any, id: number) => h.db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as any;
const splits = (h: any, id: number) => h.db.prepare('SELECT category_id, amount_cents FROM transaction_splits WHERE transaction_id=? ORDER BY id').all(id) as any[];
const csvOf = (...lines: string[]) => ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo', ...lines].join('\n') + '\n';
const importCsv = (h: any, csv: string) => { const m = suggestMapping(parseCsv(csv)); return commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }); };

describe('adding a tip to a pending transaction', () => {
  it('raises the amount and its category split by the tip, and remembers the tip', () => {
    const h = seedHousehold(); const id = pending(h);
    setSplits(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: -2000 }]);
    const v = row(h, id).version;
    setTip(h.db, id, 400);
    expect(row(h, id)).toMatchObject({ amount_cents: -2400, tip_cents: 400, status: 'provisional' });
    expect(row(h, id).version).toBeGreaterThan(v);
    expect(splits(h, id)).toEqual([{ category_id: h.cats['Eating Out'], amount_cents: -2400 }]);
    expect(h.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='transaction' AND entity_id=? AND action='tip'").get(String(id))).toEqual({ c: 1 });
  });

  it('setting a tip again replaces the old one instead of stacking; zero takes it off', () => {
    const h = seedHousehold(); const id = pending(h);
    setSplits(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: -2000 }]);
    setTip(h.db, id, 400); setTip(h.db, id, 300);
    expect(row(h, id)).toMatchObject({ amount_cents: -2300, tip_cents: 300 });
    setTip(h.db, id, 0);
    expect(row(h, id)).toMatchObject({ amount_cents: -2000, tip_cents: 0 });
    expect(splits(h, id)).toEqual([{ category_id: h.cats['Eating Out'], amount_cents: -2000 }]);
  });

  it('with several splits the tip goes on the last one and the splits still add up to the amount', () => {
    const h = seedHousehold(); const id = pending(h);
    setSplits(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: -1500 }, { categoryId: h.cats['Groceries'], amountCents: -500 }]);
    setTip(h.db, id, 250);
    const s = splits(h, id);
    expect(s.map((x) => x.amount_cents)).toEqual([-1500, -750]);
    expect(s.reduce((a, x) => a + x.amount_cents, 0)).toBe(row(h, id).amount_cents);
  });

  it('works before the transaction has a category, and a "never posted" charge can still take a tip', () => {
    const h = seedHousehold(); const id = pending(h);
    setTip(h.db, id, 500);
    expect(row(h, id).amount_cents).toBe(-2500);
    expect(splits(h, id)).toEqual([]);
    h.db.prepare("UPDATE transactions SET status='stale' WHERE id=?").run(id);
    setTip(h.db, id, 600);
    expect(row(h, id)).toMatchObject({ amount_cents: -2600, status: 'stale' });
  });

  it('refuses anything that is not a pending expense, and a tip that is not a whole number of cents >= 0', () => {
    const h = seedHousehold();
    const posted = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-03', amountCents: -2000, descriptor: 'POSTED CAFE' });
    expect(() => setTip(h.db, posted, 300)).toThrow(/pending/i);
    const hidden = pending(h); ignoreTransaction(h.db, hidden, 'user');
    expect(() => setTip(h.db, hidden, 300)).toThrow(/pending/i);
    const refund = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-03', amountCents: 2000, descriptor: 'REFUND', status: 'provisional', kind: 'income' });
    expect(() => setTip(h.db, refund, 300)).toThrow(/spending/i);
    const ok = pending(h);
    for (const bad of [-100, 1.5, NaN]) expect(() => setTip(h.db, ok, bad)).toThrow(/tip/i);
    expect(() => setTip(h.db, 99999, 100)).toThrow(/not found/i);
    expect(row(h, ok)).toMatchObject({ amount_cents: -2000, tip_cents: 0 });
  });
});

describe('a tip makes the bank file match the pending charge exactly', () => {
  it('pairs a posted amount far beyond the 25% tolerance, and keeps the category', () => {
    const h = seedHousehold(); const id = pending(h, -1000, 'EL RINCONSITO');
    setSplits(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }]);
    // a $10 bill with a $4 (40%) tip: outside the tolerance, so without the tip it is not paired
    const noTip = seedHousehold(); pending(noTip, -1000, 'EL RINCONSITO');
    expect(importCsv(noTip, csvOf('10/03/2026,10/05/2026,EL RINCONSITO SEATTLE WA,Food,Sale,-14.00,')).supersededProvisionals).toBe(0);
    setTip(h.db, id, 400);
    expect(importCsv(h, csvOf('10/03/2026,10/05/2026,EL RINCONSITO SEATTLE WA,Food,Sale,-14.00,')).supersededProvisionals).toBe(1);
    const live = h.db.prepare("SELECT t.status, t.amount_cents, s.category_id FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.status!='void'").all();
    expect(live).toEqual([{ status: 'posted', amount_cents: -1400, category_id: h.cats['Eating Out'] }]);
  });

  it('resolves two look-alike pending charges that tolerance matching would leave ambiguous', () => {
    const h = seedHousehold();
    const a = pending(h, -2000, 'EL RINCONSITO', '2026-10-03'); const b = pending(h, -2200, 'EL RINCONSITO', '2026-10-03');
    // the $22 dinner had a $3 tip, the $20 one had none: posted $25 and $20
    setTip(h.db, b, 300);
    const r = importCsv(h, csvOf('10/03/2026,10/05/2026,EL RINCONSITO SEATTLE WA,Food,Sale,-25.00,', '10/03/2026,10/05/2026,EL RINCONSITO SEATTLE WA,Food,Sale,-20.00,'));
    expect(r.supersededProvisionals).toBe(2);
    expect(row(h, a).status).toBe('void'); expect(row(h, b).status).toBe('void');
  });
});

describe('API: POST /api/transactions/:id/tip', () => {
  const H = { 'x-requested-with': 'hearthkeeper' };
  const app = (h: any) => buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
  it('sets the tip, shows it in the list, and answers 400 for a posted row or a bad tip', async () => {
    const h = seedHousehold(); const a = app(h); const id = pending(h);
    const ok = await a.inject({ method: 'POST', url: `/api/transactions/${id}/tip`, headers: H, payload: { tipCents: 450 } });
    expect(ok.statusCode).toBe(200);
    const rows = (await a.inject({ url: '/api/transactions?limit=5' })).json();
    expect(rows.find((r: any) => r.id === id)).toMatchObject({ amount_cents: -2450, tip_cents: 450 });
    expect((await a.inject({ method: 'POST', url: `/api/transactions/${id}/tip`, headers: H, payload: { tipCents: -5 } })).statusCode).toBe(400);
    const posted = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-03', amountCents: -2000, descriptor: 'POSTED' });
    const bad = await a.inject({ method: 'POST', url: `/api/transactions/${posted}/tip`, headers: H, payload: { tipCents: 300 } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toMatch(/pending/i);
    expect((await a.inject({ method: 'POST', url: '/api/transactions/99999/tip', headers: H, payload: { tipCents: 300 } })).statusCode).toBe(404);
  });
});
