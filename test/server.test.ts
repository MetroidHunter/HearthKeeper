import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { createToken, clearParsers } from '../src/ingest/events.js';
import { signSession, verifySession } from '../src/server/auth.js';
import { addRule } from '../src/core/rules.js';

const H = { 'x-requested-with': 'hearthkeeper' };
beforeEach(() => clearParsers());
const mk = () => { const h = seedHousehold(); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 's' }, now: () => '2026-10-04' }); return { h, app }; };

describe('api', () => {
  it('requires the CSRF header for mutations', async () => {
    const { app } = mk();
    expect((await app.inject({ method: 'POST', url: '/api/rules/backtest', payload: { match: { all_of: [] } } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/rules/backtest', headers: H, payload: { match: { all_of: [] } } })).statusCode).toBe(200);
  });

  it('google mode rejects anonymous and non-allowlisted users', async () => {
    const h = seedHousehold();
    const app = buildApp(h.db, { auth: { mode: 'google', allowlist: ['me@x.com'], sessionSecret: 'sec' }, now: () => '2026-10-04' });
    expect((await app.inject({ url: '/api/budget' })).statusCode).toBe(401);
    const good = signSession('sec', 'me@x.com'), bad = signSession('sec', 'eve@x.com'), forged = signSession('other', 'me@x.com');
    expect((await app.inject({ url: '/api/budget', headers: { cookie: `hk_session=${good}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/budget', headers: { cookie: `hk_session=${bad}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/budget', headers: { cookie: `hk_session=${forged}` } })).statusCode).toBe(401);
    expect(verifySession('sec', good)).toBe('me@x.com');
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('device ingest: bearer token captures and parses a Greenlight message (IFTTT webhook shape)', async () => {
    const { h, app } = mk();
    const t = createToken(h.db, 'ifttt', 'device', 24);
    expect((await app.inject({ method: 'POST', url: '/ingest/device', payload: { text: '$50.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM' } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: `/ingest/device?token=${t.secret}`, payload: { text: '$50.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().duplicate).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/ingest/device?token=${t.secret}`, payload: { text: '$50.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM' } })).json().duplicate).toBe(true);
    const txns = await app.inject({ url: '/api/transactions?hidden=1' });
    expect(txns.json()).toHaveLength(1);
    // plain text body (what a webhook with a raw body sends)
    const r2 = await app.inject({ method: 'POST', url: `/ingest/device?token=${t.secret}`, headers: { 'content-type': 'text/plain' }, payload: '$100.00 allowance transferred to Marion on October 3, 2026 at 09:16AM' });
    expect(r2.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/transactions?hidden=1' })).json()).toHaveLength(2);
  });

  it('email ingest of an unknown shape is captured, creates nothing, and shows up in Shapes', async () => {
    const { h, app } = mk();
    const t = createToken(h.db, 'receiver', 'email');
    const r = await app.inject({ method: 'POST', url: `/ingest/email?token=${t.secret}&source=chase_alert`, payload: { text: 'You made a $9.40 transaction at SQ *NEW CAFE', messageId: 'abc' } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/transactions?hidden=1' })).json()).toHaveLength(0);
    const shapes = (await app.inject({ url: '/api/shapes' })).json();
    expect(shapes[0]).toMatchObject({ source: 'chase_alert', count: 1, unparsed: 1 });
  });

  it('workflow: import -> inbox -> answer with learned rule -> budget page and pie', async () => {
    const { h, app } = mk();
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n10/01/2026,10/02/2026,CHIPOTLE 1234,Food,Sale,-14.20,\n';
    const sug = (await app.inject({ method: 'POST', url: '/api/imports/suggest-mapping', headers: H, payload: { csv } })).json();
    const spec = { columnMap: sug.columnMap, dateFormat: sug.dateFormat, signRule: sug.signRule, skipRows: 0 };
    const imp = (await app.inject({ method: 'POST', url: '/api/imports/commit', headers: H, payload: { institution: 'Chase', csv, spec } })).json();
    expect(imp.imported).toBe(1);
    const inbox = (await app.inject({ url: '/api/inbox' })).json();
    expect(inbox.needsCategory).toHaveLength(1);
    const id = inbox.needsCategory[0].id;
    const ans = await app.inject({ method: 'POST', url: `/api/transactions/${id}/categorize`, headers: H, payload: { categoryId: h.cats['Eating Out'], makeRule: 'suggest' } });
    expect(ans.json().rule.backtest.matched).toBe(1);
    expect((await app.inject({ url: '/api/inbox' })).json().needsCategory).toHaveLength(0);
    const budget = (await app.inject({ url: '/api/budget' })).json();
    const eo = budget.rows.find((r: any) => r.name === 'Eating Out');
    expect(eo.spent[0]).toBe(1420);
    expect(eo.currentCents).toBe(10 * 30000 - 1420);
    const pie = (await app.inject({ url: '/api/budget/pie' })).json();
    expect(pie.groups.find((g: any) => g.name === 'Food').share).toBeGreaterThan(0);
    expect(Math.round(pie.groups.reduce((a: number, g: any) => a + g.share, 0) * 1000) / 1000).toBe(1);
    // same merchant next time gets the learned suggestion
    const csv2 = csv.replace('10/01/2026', '10/03/2026').replace('10/02/2026', '10/03/2026');
    await app.inject({ method: 'POST', url: '/api/imports/commit', headers: H, payload: { institution: 'Chase', csv: csv2 } });
    const t = h.db.prepare("SELECT decided_rule_id r, review_state s FROM transactions WHERE occurred_on='2026-10-03'").get() as any;
    expect(t.r).not.toBeNull();
    expect(t.s).toBe('needs_category'); // suggest mode: still prompts, pre-selected
  });

  it('optimistic locking returns 409 on a stale edit', async () => {
    const { h, app } = mk();
    const cid = h.cats['Groceries'];
    const ok = await app.inject({ method: 'PATCH', url: `/api/categories/${cid}`, headers: H, payload: { name: 'Groceries!', version: 1 } });
    expect(ok.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PATCH', url: `/api/categories/${cid}`, headers: H, payload: { name: 'x', version: 1 } });
    expect(stale.statusCode).toBe(409);
  });

  it('plans over the api: diff then go live', async () => {
    const { h, app } = mk();
    const sc = (await app.inject({ method: 'POST', url: '/api/scenarios', headers: H, payload: { name: 'S', lines: [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }] } })).json().id;
    const pid = (await app.inject({ method: 'POST', url: '/api/plans', headers: H, payload: { name: 'P', from: 'live' } })).json().id;
    await app.inject({ method: 'PUT', url: `/api/plans/${pid}/scenario`, headers: H, payload: { scenarioId: sc } });
    await app.inject({ method: 'PUT', url: `/api/plans/${pid}/items/${h.cats['Groceries']}`, headers: H, payload: { monthlyCents: 90000 } });
    const d = (await app.inject({ url: `/api/plans/${pid}/diff` })).json();
    expect(d.rows).toHaveLength(1); expect(d.incomeNew).toBe(1246667);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${pid}/make-live`, headers: H, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/budget' })).json().header).toMatchObject({ livePlan: 'P', incomeCents: 1246667 });
  });
});
