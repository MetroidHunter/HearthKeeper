import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { createScenario } from '../src/core/earnings.js';
import { createPlan, makeLive } from '../src/core/plans.js';

const H = { 'x-requested-with': 'hearthkeeper' };
function api() {
  const h = seedHousehold();
  const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, now: () => '2026-10-04' });
  const call = (method: string, url: string, payload?: object) => app.inject({ method: method as any, url, headers: H, payload });
  const sc = createScenario(h.db, 'S', [{ label: 'x', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
  const live = createPlan(h.db, 'Live one', { livePlan: true }, '2026-10'); h.db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(sc, live);
  makeLive(h.db, live, { effectiveMonth: '2026-01', today: '2026-10-04', confirmRestate: 'RESTATE' });
  const draft = createPlan(h.db, 'Draft one', { livePlan: true }, '2026-10');
  return { h, call, live, draft };
}

describe('plans API', () => {
  it('lists plans with their phase and go-live month', async () => {
    const { call, live, draft } = api();
    const rows = (await call('GET', '/api/plans')).json();
    expect(rows.find((p: any) => p.id === live)).toMatchObject({ phase: 'live', effective_month: '2026-01' });
    expect(rows.find((p: any) => p.id === draft)).toMatchObject({ phase: 'draft', itemCount: expect.any(Number) });
  });

  it('a plan\'s page data: items carry their group, actions are listed', async () => {
    const { h, call, draft } = api();
    await call('POST', `/api/plans/${draft}/actions`, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Manicure'], cents: 1000 });
    const d = (await call('GET', `/api/plans/${draft}`)).json();
    expect(d.phase).toBe('draft');
    expect(d.items.find((i: any) => i.name === 'Groceries').group_name).toBe('Food');
    expect(d.actions).toMatchObject([{ kind: 'move', name: 'Groceries', to_name: 'Manicure', cents: 1000 }]);
    expect((await call('GET', '/api/plans/9999')).statusCode).toBe(404);
  });

  it('add and remove actions; the diff lists them; bad input is a 400', async () => {
    const { h, call, draft } = api();
    expect((await call('POST', `/api/plans/${draft}/actions`, { kind: 'move', fromCategoryId: h.cats['Groceries'], toCategoryId: h.cats['Groceries'], cents: 1000 })).statusCode).toBe(400);
    expect((await call('POST', `/api/plans/${draft}/actions`, { kind: 'teleport' })).statusCode).toBe(400);
    const a = (await call('POST', `/api/plans/${draft}/actions`, { kind: 'retire', categoryId: h.cats['Manicure'], moveBalanceTo: h.cats['Groceries'] })).json().id;
    const diff = (await call('GET', `/api/plans/${draft}/diff?month=2026-10`)).json();
    expect(diff.retires).toMatchObject([{ name: 'Manicure', moveToName: 'Groceries', canRetire: true }]);
    expect((await call('DELETE', `/api/plans/${draft}/actions/${a}`)).statusCode).toBe(200);
    expect((await call('GET', `/api/plans/${draft}/diff?month=2026-10`)).json().retires).toEqual([]);
  });

  it('go-live: a bad month is a 400; a retirement for a later month is scheduled, not applied', async () => {
    const { h, call, draft } = api();
    await call('POST', `/api/plans/${draft}/actions`, { kind: 'retire', categoryId: h.cats['Manicure'] });
    expect((await call('POST', `/api/plans/${draft}/make-live`, { effectiveMonth: 'bad' })).statusCode).toBe(400);
    expect((await call('GET', `/api/plans/${draft}/diff?month=bad`)).statusCode).toBe(400);
    expect((await call('POST', `/api/plans/${draft}/make-live`, { effectiveMonth: '2026-12' })).statusCode).toBe(200);
    expect((h.db.prepare('SELECT status FROM categories WHERE id=?').get(h.cats['Manicure']) as any).status).toBe('active');
    expect((await call('GET', `/api/plans/${draft}`)).json().actions[0]).toMatchObject({ kind: 'retire', applied_at: null });
  });

  it('cancels a scheduled plan (back to a draft); anything else is a 400', async () => {
    const { h, call, live, draft } = api();
    expect((await call('POST', `/api/plans/${draft}/cancel`)).statusCode).toBe(400);   // a draft
    expect((await call('POST', `/api/plans/${live}/cancel`)).statusCode).toBe(400);    // in force
    await call('PUT', `/api/plans/${draft}/items/${h.cats['Groceries']}`, { monthlyCents: 95000 });
    await call('POST', `/api/plans/${draft}/make-live`, { effectiveMonth: '2026-11' });
    expect((await call('GET', '/api/plans')).json().find((p: any) => p.id === draft).phase).toBe('scheduled');
    expect((await call('POST', `/api/plans/${draft}/cancel`)).statusCode).toBe(200);
    const after = (await call('GET', '/api/plans')).json();
    expect(after.find((p: any) => p.id === draft)).toMatchObject({ phase: 'draft', effective_month: null });
    expect(after.find((p: any) => p.id === live).phase).toBe('live');
    expect((await call('GET', '/api/budget?today=2026-11-02')).json().rows.find((r: any) => r.name === 'Groceries').targetCents).toBe(80000);
  });
});
