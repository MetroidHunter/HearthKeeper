import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, ignoreTransaction } from '../src/core/transactions.js';
import { markStale, uploadFrontier, commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { inbox } from '../src/core/reports.js';

/** An alert from Chase: pending until a bank file posts it. */
const alert = (h: any, acct: number, date: string, cents = -1000, desc = 'COFFEE') => createTransaction(h.db, { accountId: acct, occurredOn: date, amountCents: cents, descriptor: desc, status: 'provisional', authorizedAt: `${date}T18:00:00Z` });
/** A row that came from a bank file (it carries a fingerprint), posted on `postedOn`. */
let n = 0;
const fromFile = (h: any, acct: number, postedOn: string, desc = `FILE ROW ${n}`) => createTransaction(h.db, { accountId: acct, occurredOn: postedOn, postedOn, amountCents: -100 - n, descriptor: desc, fingerprint: `fp-${n++}` });
const status = (h: any, id: number) => (h.db.prepare('SELECT status s FROM transactions WHERE id=?').get(id) as any).s;

describe('"never posted" follows the bank uploads, not the calendar', () => {
  it('with no upload for the account, a pending charge is never "never posted", however old', () => {
    const h = seedHousehold(); const a = alert(h, h.chase, '2026-01-02');
    expect(markStale(h.db)).toBe(0); expect(status(h, a)).toBe('provisional');
  });

  it('a $10 Chase charge on 10/02 stays pending while the last Chase upload ends before 10/02', () => {
    const h = seedHousehold(); fromFile(h, h.chase, '2026-10-01'); const a = alert(h, h.chase, '2026-10-02');
    expect(uploadFrontier(h.db, h.chase)).toBe('2026-10-01');
    expect(markStale(h.db)).toBe(0); expect(status(h, a)).toBe('provisional');
    expect(inbox(h.db, '2026-10-30').counts.stale).toBe(0); // however long ago "today" is from it
  });

  it('a charge on the very last day the upload covers is still pending: only a strictly later posted row proves it should have been there', () => {
    const h = seedHousehold(); fromFile(h, h.chase, '2026-10-02'); const a = alert(h, h.chase, '2026-10-02');
    expect(markStale(h.db)).toBe(0); expect(status(h, a)).toBe('provisional');
  });

  it('once an upload posts something later and the charge is not in it, the charge becomes "never posted"', () => {
    const h = seedHousehold(); fromFile(h, h.chase, '2026-10-01'); const a = alert(h, h.chase, '2026-10-02');
    markStale(h.db); expect(status(h, a)).toBe('provisional');
    fromFile(h, h.chase, '2026-10-05'); // the next Chase upload runs to 10/05 and does not contain the $10
    expect(markStale(h.db)).toBe(1); expect(status(h, a)).toBe('stale');
    expect(inbox(h.db, '2026-10-06').counts.stale).toBe(1);
  });

  it('only the same account counts: a Wells Fargo upload says nothing about a Chase alert', () => {
    const h = seedHousehold(); fromFile(h, h.wf, '2026-10-20'); const a = alert(h, h.chase, '2026-10-02');
    expect(markStale(h.db)).toBe(0); expect(status(h, a)).toBe('provisional');
  });

  it('alerts and manual entries are not uploads: they do not move the frontier', () => {
    const h = seedHousehold(); alert(h, h.chase, '2026-10-09'); createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-10', amountCents: -500, descriptor: 'CASH' });
    expect(uploadFrontier(h.db, h.chase)).toBeNull();
  });

  it('a charge flagged "never posted" under the old 7-day rule goes back to pending when no upload shows it is overdue', () => {
    const h = seedHousehold(); const a = alert(h, h.chase, '2026-10-02');
    h.db.prepare("UPDATE transactions SET status='stale' WHERE id=?").run(a);
    expect(markStale(h.db)).toBe(0); expect(status(h, a)).toBe('provisional');
  });

  it('a charge you already hid as never posted is left alone', () => {
    const h = seedHousehold(); fromFile(h, h.chase, '2026-10-01'); const a = alert(h, h.chase, '2026-10-02'); fromFile(h, h.chase, '2026-10-05'); markStale(h.db);
    ignoreTransaction(h.db, a, 'pending charge never posted', 'user'); fileMore(h);
    expect(status(h, a)).toBe('stale');
  });
  const fileMore = (h: any) => markStale(h.db);

  it('importing a bank file settles it right away, with no waiting for a scheduler tick', () => {
    const h = seedHousehold(); const a = alert(h, h.chase, '2026-10-02', -1000, 'COFFEE SHOP');
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n10/05/2026,10/06/2026,SOMETHING ELSE,Shopping,Sale,-9.99,\n';
    const m = suggestMapping(parseCsv(csv));
    commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 });
    expect(status(h, a)).toBe('stale');
  });
});
