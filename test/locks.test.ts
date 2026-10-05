import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { closePeriod } from '../src/core/close.js';
import { listPeriods, reopenPeriod, PeriodClosedError } from '../src/core/locks.js';
import { createTransaction, setSplits, ignoreTransaction, classify } from '../src/core/transactions.js';
import { manualTransfer } from '../src/core/transfers.js';
import { setBudget } from '../src/core/categories.js';
import { createPlan, setPlanItem, makeLive } from '../src/core/plans.js';
import { addRule } from '../src/core/rules.js';
import { buildApp } from '../src/server/app.js';

describe('period soft lock (design §13.4)', () => {
  function world() {
    const h = seedHousehold();
    const old = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-08-10', amountCents: -2000, descriptor: 'OLD' });
    setSplits(h.db, old, [{ categoryId: h.cats['Groceries'], amountCents: -2000 }], 'user');
    const pid = closePeriod(h.db, '2026-08-31', 'me');
    return { ...h, old, pid };
  }
  it('blocks human edits, transfers and budget changes inside a closed period, but not after it', () => {
    const h = world();
    expect(() => setSplits(h.db, h.old, [{ categoryId: h.cats['Eating Out'], amountCents: -2000 }], 'user')).toThrow(PeriodClosedError);
    expect(() => ignoreTransaction(h.db, h.old, 'user', 'me')).toThrow(/closed/);
    expect(() => manualTransfer(h.db, '2026-08-20', h.cats['Groceries'], h.cats['Eating Out'], 100)).toThrow(/closed/);
    expect(() => setBudget(h.db, h.cats['Groceries'], 1, '2026-08', { actor: 'me' })).toThrow(/closed/);
    expect(() => manualTransfer(h.db, '2026-09-02', h.cats['Groceries'], h.cats['Eating Out'], 100)).not.toThrow();
    expect(() => setBudget(h.db, h.cats['Groceries'], 85000, '2026-09', { actor: 'me' })).not.toThrow();
  });
  it('rules and ingest may still categorize a late arrival in a closed month (people may not)', () => {
    const h = world();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'late cafe' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
    const late = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-08-15', amountCents: -900, descriptor: 'LATE CAFE' });
    expect(classify(h.db, late).outcome).toBe('categorized');
  });
  it('a retroactive plan go-live into a closed month rolls back atomically', () => {
    const h = world();
    const p = createPlan(h.db, 'Retro', { livePlan: true }, '2026-10'); setPlanItem(h.db, p, h.cats['Groceries'], 99900);
    expect(() => makeLive(h.db, p, { effectiveMonth: '2026-08', today: '2026-10-04', confirmRestate: 'RESTATE' })).toThrow(/closed/);
    expect((h.db.prepare('SELECT status FROM budget_plans WHERE id=?').get(p) as any).status).toBe('draft');
  });
  it('reopening needs a reason, is audited, and re-allows edits', () => {
    const h = world();
    expect(() => reopenPeriod(h.db, h.pid, 'me', '  ')).toThrow(/reason/);
    reopenPeriod(h.db, h.pid, 'me', 'forgot a refund');
    expect(listPeriods(h.db)).toEqual([]);
    expect(() => setSplits(h.db, h.old, [{ categoryId: h.cats['Eating Out'], amountCents: -2000 }], 'user')).not.toThrow();
    expect(h.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='close_period' AND action='reopen'").get()).toEqual({ c: 1 });
  });
  it('over the API a locked edit is a 409, and DELETE /api/close/:id reopens', async () => {
    const h = world();
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    const H = { 'x-requested-with': 'hearthkeeper' };
    const r = await app.inject({ method: 'POST', url: `/api/transactions/${h.old}/categorize`, headers: H, payload: { categoryId: h.cats['Eating Out'] } });
    expect(r.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/close/${h.pid}`, headers: H, payload: { reason: 'oops' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/transactions/${h.old}/categorize`, headers: H, payload: { categoryId: h.cats['Eating Out'] } })).statusCode).toBe(200);
  });
});
