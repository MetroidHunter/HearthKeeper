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
  it('merchants are paged, searchable, most-used first, and can be filtered to those without a usual category', async () => {
    const h = seedHousehold(); const a = app(h);
    for (let i = 0; i < 120; i++) h.db.prepare("INSERT INTO merchants(name, review_state) VALUES (?, 'reviewed')").run(`Shop ${i}`);
    const z = Number(h.db.prepare("INSERT INTO merchants(name, review_state) VALUES ('Zed Cafe','unreviewed')").run().lastInsertRowid);
    for (let i = 0; i < 3; i++) createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: -500, descriptor: `ZED ${i}` }), h.db.prepare('UPDATE transactions SET merchant_id=? WHERE descriptor_raw=?').run(z, `ZED ${i}`);
    const p1 = (await a.inject({ url: '/api/merchants?limit=50' })).json();
    expect(p1.rows).toHaveLength(50); expect(p1.total).toBe(121); expect(p1.unreviewed).toBe(1); expect(p1.rows[0].name).toBe('Zed Cafe'); // most transactions first
    const nd = (await a.inject({ url: '/api/merchants?review=nohistory' })).json();
    expect(nd.total).toBe(1); expect(nd.withoutHistory).toBe(1); // only shops you actually bought from, and never categorized
    // answering teaches the merchant: its history now shows it, and it leaves the "never categorized" list
    const zt = (h.db.prepare("SELECT id FROM transactions WHERE merchant_id=? ORDER BY id").all(z) as any[]).map((r) => r.id);
    for (const id of zt.slice(0, 2)) await a.inject({ method: 'POST', url: `/api/transactions/${id}/categorize`, headers: H, payload: { categoryId: h.cats['Eating Out'] } });
    await a.inject({ method: 'POST', url: `/api/transactions/${zt[2]}/categorize`, headers: H, payload: { categoryId: h.cats['Groceries'] } });
    expect((await a.inject({ url: '/api/merchants?review=nohistory' })).json().total).toBe(0);
    expect((await a.inject({ url: '/api/merchants?q=zed' })).json().rows[0].history.map((x: any) => [x.name, x.n])).toEqual([['Eating Out', 2], ['Groceries', 1]]);
    expect((await a.inject({ url: '/api/merchants?q=shop 11' })).json().rows.length).toBeGreaterThan(0);
  });
});

describe('inbox amounts for Greenlight reclasses', () => {
  it('shows the real spend (not the zero total) so budget impact is right', () => {
    const h = seedHousehold();
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: 0, descriptor: 'RECLASS', kind: 'greenlight_reclass' } as any);
    h.db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?,?)').run(id, null, -2183, 'greenlight_reclass');
    h.db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?,?)').run(id, h.cats['Groceries'], 2183, 'greenlight_reclass');
    h.db.prepare("UPDATE transactions SET review_state='needs_category' WHERE id=?").run(id);
    const t = inbox(h.db, '2026-10-05').needsCategory.find((x: any) => x.id === id)!;
    expect(t.effective_cents).toBe(-2183);
  });
});

describe('suggestions respect the direction of the money', () => {
  it('offers income categories for a deposit and expense categories for a charge', async () => {
    const { suggestionsFor } = await import('../src/core/reports.js');
    const h = seedHousehold();
    const day = new Date().toISOString().slice(0, 10);
    const pay = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: 500000, descriptor: 'PAYROLL' });
    const inc = h.db.prepare("SELECT id FROM categories WHERE kind!='expense' AND status='active' LIMIT 1").get() as { id: number } | undefined;
    if (inc) { const old = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: 100, descriptor: 'OLD PAY' }); setSplits(h.db, old, [{ categoryId: inc.id, amountCents: 100 }]); }
    const spend = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -900, descriptor: 'STORE' });
    const g = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -900, descriptor: 'OLD STORE' }); setSplits(h.db, g, [{ categoryId: h.cats['Groceries'], amountCents: -900 }]);
    const kinds = (id: number) => suggestionsFor(h.db, { id, decided_rule_id: null, descriptor_clean: null }).map((s) => (h.db.prepare('SELECT kind FROM categories WHERE id=?').get(s.id) as any).kind);
    expect(kinds(spend).every((k) => k === 'expense')).toBe(true);
    expect(kinds(pay).every((k) => k !== 'expense')).toBe(true);
  });
});

describe('inbox items: one entry per transaction with every open reason', () => {
  it('a wrapper payment that is uncategorized AND waiting on a note appears once with both reasons; categorizing leaves the note reason', async () => {
    const h = seedHousehold();
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -1500, descriptor: 'VENMO PAYMENT 123' });
    h.db.prepare("UPDATE transactions SET note_state='awaiting_note' WHERE id=?").run(id);
    let i = inbox(h.db, '2026-10-06');
    expect(i.items.filter((t: any) => t.id === id)).toHaveLength(1);
    expect(i.items.find((t: any) => t.id === id).reasons.map((r: any) => r.reason).sort()).toEqual(['needs_category', 'needs_note']);
    expect(i.counts.total).toBe(1);
    setSplits(h.db, id, [{ categoryId: h.cats['Groceries'], amountCents: -1500 }]);
    i = inbox(h.db, '2026-10-06');
    const t = i.items.find((x: any) => x.id === id);
    expect(t.reasons.map((r: any) => r.reason)).toEqual(['needs_note']); // still here, for the note
    expect(t.categories).toBe('Groceries'); // and it shows what was just decided
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    await app.inject({ method: 'PATCH', url: `/api/transactions/${id}`, headers: { 'x-requested-with': 'hearthkeeper' }, payload: { noteState: 'not_needed' } });
    expect(inbox(h.db, '2026-10-06').items.find((x: any) => x.id === id)).toBeUndefined();
  });
  it('ingest messages are paged, filterable, searchable and expandable', async () => {
    const { captureEvent } = await import('../src/ingest/events.js');
    const h = seedHousehold(); const a = app(h);
    for (let i = 0; i < 60; i++) captureEvent(h.db, { source: i % 3 ? 'chase_alert' : 'wf_notice', channel: 'email', payload: `message number ${i} body`, headers: { Subject: `Subject ${i}`, From: 'x@y.com' }, dedupeKey: `k${i}` });
    const p1 = (await a.inject({ url: '/api/ingest/list?limit=25' })).json();
    expect(p1.total).toBe(60); expect(p1.rows).toHaveLength(25); expect(p1.rows[0].subject).toBe('Subject 59'); expect(p1.sources).toEqual(['chase_alert', 'wf_notice']);
    expect(p1.rows[0].headers_json).toBeUndefined(); expect(p1.rows[0].payload).toBeUndefined(); // the list never carries whole messages
    const p3 = (await a.inject({ url: '/api/ingest/list?limit=25&offset=50' })).json(); expect(p3.rows).toHaveLength(10);
    expect((await a.inject({ url: '/api/ingest/list?source=wf_notice' })).json().total).toBe(20);
    expect((await a.inject({ url: '/api/ingest/list?q=number 41' })).json().total).toBe(1);
    const one = (await a.inject({ url: `/api/ingest/events/${p1.rows[0].id}` })).json();
    expect(one.payload).toContain('message number 59'); expect(one.headers.Subject).toBe('Subject 59');
    expect((await a.inject({ url: '/api/ingest/events/99999' })).statusCode).toBe(404);
    const id = p1.rows[0].id;
    await a.inject({ method: 'POST', url: `/api/ingest/events/${id}/noise`, headers: H });
    expect((await a.inject({ url: '/api/ingest/list?status=noise' })).json().total).toBe(1);
  });
});
