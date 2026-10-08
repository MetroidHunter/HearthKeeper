import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, classify, setSplits } from '../src/core/transactions.js';
import { addRule } from '../src/core/rules.js';
import { openNotices, dismissNotice } from '../src/core/notices.js';
import { inbox } from '../src/core/reports.js';

const scene = () => {
  const h = seedHousehold();
  addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'bigshop' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
  const spend = (cents: number, day = '2026-10-05', desc = 'BIGSHOP 1') => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -cents, descriptor: desc }); classify(h.db, id); return id; };
  return { h, spend };
};

describe('heads-up when an automatic categorization pushes an envelope over budget', () => {
  it('is raised once, by the payment that crosses the line, and says what happened', () => {
    const { h, spend } = scene();
    spend(10 * 30000 - 1000);                 // Eating Out has accrued $3,000 by October: $10 left, still fine
    expect(openNotices(h.db)).toEqual([]);
    const crossing = spend(5000);             // $50 more: over by $40
    const n = openNotices(h.db) as any[];
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'over_budget', category_id: h.cats['Eating Out'], txn_id: crossing });
    expect(n[0].message).toMatch(/^Eating Out went over budget: -\$40\.00 left in it after BIGSHOP 1 \(\$50\.00\) was filed there automatically\.$/);
    spend(2000);                               // already over: nothing new to say while this one is open
    expect(openNotices(h.db)).toHaveLength(1);
    expect(inbox(h.db, '2026-10-06').notices).toHaveLength(1);  // Home gets it with the inbox
  });
  it('can be dismissed, and is raised again only when the envelope is pushed over again', () => {
    const { h, spend } = scene();
    spend(10 * 30000 - 1000); spend(5000);
    const id = (openNotices(h.db)[0] as any).id;
    expect(dismissNotice(h.db, id)).toBe(true); expect(dismissNotice(h.db, id)).toBe(false);
    expect(openNotices(h.db)).toEqual([]);
    spend(2000);                                            // still over, the same overage: not news
    expect(openNotices(h.db)).toEqual([]);
    const t = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-10-06', amountCents: 1000000, descriptor: 'REFUND' }); // money comes back into the envelope
    setSplits(h.db, t, [{ categoryId: h.cats['Eating Out'], amountCents: 1000000 }]);
    spend(1000000 + 100);                                   // and is spent past zero again
    expect(openNotices(h.db)).toHaveLength(1);
  });
  it('is only for automatic answers, spending, expense envelopes and recent payments', () => {
    const { h, spend } = scene();
    // a person's own answer does not raise it
    const mine = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -(10 * 30000 + 5000), descriptor: 'OTHER' });
    setSplits(h.db, mine, [{ categoryId: h.cats['Eating Out'], amountCents: -(10 * 30000 + 5000) }], 'user');
    expect(openNotices(h.db)).toEqual([]);
    // history: a payment dated long before the newest data is not news, even if an automatic rule files it
    const { h: h2, spend: spend2 } = scene();
    spend2(1000, '2026-10-05', 'RECENT');                    // the newest data is October 5
    spend2(10 * 30000 + 5000, '2026-07-01', 'BIGSHOP OLD'); // an old payment filed automatically
    expect(openNotices(h2.db)).toEqual([]);
    void h; void spend;
  });
  it('is not raised for a category that stays within its budget', () => {
    const { h, spend } = scene();
    spend(1000); spend(2000);
    expect(openNotices(h.db)).toEqual([]);
  });
});

describe('API', () => {
  it('dismissing through the API removes it from the inbox', async () => {
    const { buildApp } = await import('../src/server/app.js');
    const { h, spend } = scene(); spend(10 * 30000 - 1000); spend(5000);
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    const id = (await app.inject({ url: '/api/inbox' })).json().notices[0].id;
    expect((await app.inject({ method: 'POST', url: `/api/notices/${id}/dismiss`, headers: { 'x-requested-with': 'hearthkeeper' } })).json()).toEqual({ ok: true });
    expect((await app.inject({ url: '/api/inbox' })).json().notices).toEqual([]);
  });
});
