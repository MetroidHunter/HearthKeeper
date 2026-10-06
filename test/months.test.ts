import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { monthsOverview, NEEDS_WHERE } from '../src/core/months.js';
import { createTransaction, setSplits, ignoreTransaction } from '../src/core/transactions.js';
import { markStale } from '../src/ingest/import.js';
import { buildApp } from '../src/server/app.js';
import { inbox } from '../src/core/reports.js';

const item = (rows: ReturnType<typeof monthsOverview>, month: string, key: string) => rows.find((r) => r.month === month)!.items.find((i) => i.key === key)!;
const spend = (h: any, acct: number, date: string, cents: number, desc: string, cat?: string) => {
  const id = createTransaction(h.db, { accountId: acct, occurredOn: date, amountCents: cents, descriptor: desc });
  if (cat) setSplits(h.db, id, [{ categoryId: h.cats[cat], amountCents: cents }], 'user'); return id;
};

describe('months overview (the month-by-month checklist)', () => {
  it('lists every month from the first transaction to today, newest first; an empty household still shows this month', () => {
    const h = seedHousehold();
    expect(monthsOverview(h.db, '2026-10-04').map((m) => m.month)).toEqual(['2026-10']);
    spend(h, h.chase, '2026-07-15', -1000, 'A', 'Groceries');
    const rows = monthsOverview(h.db, '2026-10-04');
    expect(rows.map((m) => m.month)).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(rows[0].current).toBe(true); expect(rows[1].current).toBe(false);
  });

  it('each item counts its own month only, and says what to do via a link that opens exactly those transactions', async () => {
    const h = seedHousehold();
    spend(h, h.chase, '2026-08-10', -1000, 'WITH CAT', 'Groceries');
    spend(h, h.chase, '2026-08-11', -500, 'NO CAT 1'); spend(h, h.chase, '2026-09-02', -600, 'NO CAT 2'); spend(h, h.chase, '2026-09-03', -700, 'NO CAT 3');
    for (const id of h.db.prepare("SELECT id FROM transactions WHERE descriptor_raw LIKE 'NO CAT%'").all().map((r: any) => r.id)) h.db.prepare("UPDATE transactions SET review_state='needs_category' WHERE id=?").run(id);
    const rows = monthsOverview(h.db, '2026-10-04');
    expect(item(rows, '2026-08', 'category').count).toBe(1); expect(item(rows, '2026-09', 'category').count).toBe(2); expect(item(rows, '2026-10', 'category').count).toBe(0);
    expect(item(rows, '2026-09', 'category').link).toBe('#/transactions?month=2026-09&needs=category');
    // the link's filter returns exactly the rows that were counted
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    const got = (await app.inject({ url: '/api/transactions?from=2026-09-01&to=2026-09-30&needs=category' })).json();
    expect(got.map((t: any) => t.descriptor_raw).sort()).toEqual(['NO CAT 2', 'NO CAT 3']);
    expect((await app.inject({ url: '/api/transactions?needs=bogus' })).statusCode).toBe(400);
    expect(Object.keys(NEEDS_WHERE).sort()).toEqual(['category', 'dupes', 'flag', 'note', 'stale']);
  });

  it('notes, flags, never-posted pending charges and duplicates each show up, and clear when handled', () => {
    const h = seedHousehold();
    const a = spend(h, h.chase, '2026-09-05', -500, 'NOTE ME', 'Groceries'); h.db.prepare("UPDATE transactions SET note_state='needs_note' WHERE id=?").run(a);
    const f = spend(h, h.chase, '2026-09-06', -500, 'FLAG ME', 'Groceries'); h.db.prepare('UPDATE transactions SET flagged=1 WHERE id=?').run(f);
    const p = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-09-07', amountCents: -800, descriptor: 'PENDING', status: 'provisional' }); markStale(h.db, '2026-10-04');
    spend(h, h.chase, '2026-09-08', -900, 'TWIN'); spend(h, h.chase, '2026-09-08', -900, 'TWIN'); // identical and unconfirmed: possibly the same charge twice (confirming a row accepts it)
    let rows = monthsOverview(h.db, '2026-10-04');
    expect(['note', 'flag', 'stale', 'dupes'].map((k) => item(rows, '2026-09', k).count)).toEqual([1, 1, 1, 1]);
    expect(rows.find((r) => r.month === '2026-09')!.todo).toBeGreaterThanOrEqual(4);
    h.db.prepare("UPDATE transactions SET note_state='not_needed' WHERE id=?").run(a); h.db.prepare('UPDATE transactions SET flagged=0 WHERE id=?').run(f); ignoreTransaction(h.db, p, 'pending charge never posted', 'user');
    expect(inbox(h.db, '2026-10-04').counts.stale).toBe(0); // Home and Backlog agree: "Hide it" makes the card go away
    rows = monthsOverview(h.db, '2026-10-04');
    expect(['note', 'flag', 'stale'].map((k) => item(rows, '2026-09', k).count)).toEqual([0, 0, 0]); // hiding the never-posted charge resolved it
  });

  it('data coverage: flags an institution whose data stops before the month ends, or that has nothing in a month between two that have data; not one that did not exist yet', () => {
    const h = seedHousehold();
    spend(h, h.chase, '2026-06-10', -100, 'x', 'Groceries'); spend(h, h.chase, '2026-08-10', -100, 'x', 'Groceries'); spend(h, h.chase, '2026-10-02', -100, 'x', 'Groceries'); // Chase: nothing in July or September
    spend(h, h.wf, '2026-08-05', -100, 'y', 'Groceries'); spend(h, h.wf, '2026-09-20', -100, 'y', 'Groceries'); // Wells Fargo: starts in August, stops 9/20
    const rows = monthsOverview(h.db, '2026-10-04');
    const cov = (m: string) => item(rows, m, 'coverage');
    expect(cov('2026-06').count).toBe(0); // WF did not exist yet; Chase has data
    expect(cov('2026-07').detail).toMatch(/Chase/); expect(cov('2026-07').detail).not.toMatch(/Wells/); // gap in the middle of Chase's history
    expect(cov('2026-09').detail).toMatch(/Chase/); expect(cov('2026-09').detail).toMatch(/Wells Fargo/); // Chase gap; WF stops 9/20, 10 days before month end
    expect(cov('2026-10').detail ?? '').toMatch(/Wells Fargo/); // WF has nothing in the last 14 days
    expect(cov('2026-10').detail ?? '').not.toMatch(/Chase/);
  });

  it('an account you simply stopped uploading is flagged in every month since; one dormant for months is treated as closed', () => {
    const h = seedHousehold();
    const old = Number(h.db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Old Bank','Old Bank','bank')").run().lastInsertRowid);
    spend(h, old, '2026-01-10', -100, 'z', 'Groceries'); // went quiet in January: closed
    spend(h, h.chase, '2026-05-10', -100, 'x', 'Groceries'); spend(h, h.chase, '2026-07-20', -100, 'x', 'Groceries'); // Chase: last upload 7/20 (78 days ago)
    spend(h, h.wf, '2026-05-12', -100, 'y', 'Groceries'); for (const d of ['2026-06-12', '2026-07-12', '2026-08-12', '2026-09-12', '2026-10-04']) spend(h, h.wf, d, -100, 'y', 'Groceries'); // Wells Fargo keeps going
    const rows = monthsOverview(h.db, '2026-10-06'); const cov = (m: string) => item(rows, m, 'coverage').detail ?? '';
    for (const m of ['2026-08', '2026-09', '2026-10']) { expect(cov(m)).toMatch(/Chase/); expect(cov(m)).not.toMatch(/Wells|Old Bank/); }
    expect(cov('2026-07')).toMatch(/Chase/); // stops 7/20, 11 days before the month ends
    expect(cov('2026-06')).toMatch(/Chase/); // nothing in June between May and July data
    expect(cov('2026-05')).toBe('');
    expect(cov('2026-03')).not.toMatch(/Old Bank/); // went quiet in January and is not expected back
  });

  it('when the whole household has no transactions after some date (history imported, nothing since), every month since says so', () => {
    const h = seedHousehold();
    spend(h, h.chase, '2026-07-05', -100, 'last one', 'Groceries');
    const rows = monthsOverview(h.db, '2026-10-06');
    for (const m of ['2026-08', '2026-09', '2026-10']) expect(item(rows, m, 'coverage')).toMatchObject({ count: 1, detail: expect.stringMatching(/No transactions at all after 2026-07-05/) });
    expect(item(rows, '2026-07', 'coverage').count).toBe(1); // 7/5 is 26 days before the month ends
    expect(monthsOverview(seedHousehold().db, '2026-10-06')[0].items[0]).toMatchObject({ count: 1, detail: expect.stringMatching(/No transactions yet/) });
  });

  it('the numbers: income, spent, net, planned, transaction count, envelopes over plan, biggest category', () => {
    const h = seedHousehold();
    spend(h, h.chase, '2026-09-03', -50000, 'BIG GROCERY RUN', 'Groceries'); // Groceries plan is $800
    spend(h, h.chase, '2026-09-04', -9000, 'DINNER', 'Eating Out');
    spend(h, h.chase, '2026-09-05', -40000, 'FANCY DINNER', 'Eating Out'); // Eating Out plan $300: over
    const inc = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-09-15', amountCents: 300000, descriptor: 'GIG PAYMENT' }); setSplits(h.db, inc, [{ categoryId: h.cats['Gig Income'], amountCents: 300000 }], 'user');
    const sep = monthsOverview(h.db, '2026-10-04').find((m) => m.month === '2026-09')!.stats;
    expect(sep).toMatchObject({ income: 300000, spent: 99000, net: 201000, txns: 4, overPlan: 1, top: { name: 'Groceries', cents: 50000 } });
    expect(sep.planned).toBeGreaterThan(0);
  });

  it('a month is done exactly when nothing is left to do; late data can reopen it (there is no lock)', () => {
    const h = seedHousehold();
    spend(h, h.chase, '2026-08-10', -1000, 'ok', 'Groceries'); spend(h, h.wf, '2026-08-12', -1000, 'ok2', 'Groceries');
    spend(h, h.chase, '2026-09-10', -1000, 'ok', 'Groceries'); spend(h, h.wf, '2026-09-12', -1000, 'ok2', 'Groceries');
    spend(h, h.chase, '2026-10-02', -1000, 'ok', 'Groceries'); spend(h, h.wf, '2026-10-02', -1000, 'ok2', 'Groceries');
    let aug = monthsOverview(h.db, '2026-10-03').find((m) => m.month === '2026-08')!; expect(aug.todo).toBe(0);
    const late = spend(h, h.chase, '2026-08-20', -2500, 'LATE ARRIVAL'); h.db.prepare("UPDATE transactions SET review_state='needs_category' WHERE id=?").run(late);
    aug = monthsOverview(h.db, '2026-10-03').find((m) => m.month === '2026-08')!; expect(aug.todo).toBe(1);
    setSplits(h.db, late, [{ categoryId: h.cats['Groceries'], amountCents: -2500 }], 'user'); // and nothing blocks fixing an old month
    expect(monthsOverview(h.db, '2026-10-03').find((m) => m.month === '2026-08')!.todo).toBe(0);
  });
});
