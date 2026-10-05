import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { parseChaseAlert } from '../src/chase/parser.js';
import { captureEvent, replay, clearParsers } from '../src/ingest/events.js';
import { registerAllParsers } from '../src/ingest/parsers.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { addRule } from '../src/core/rules.js';

beforeEach(() => { clearParsers(); registerAllParsers(); });
const A = (when: string, v = 'SQ *CAFE', amt = '12.30') => `Prime Visa: You made a $${amt} transaction with ${v} on ${when} ET.`;

describe('chase alert parser (shape from IFTTT_Code.gs)', () => {
  it('parses vendor, amount and Eastern time', () => {
    const a = parseChaseAlert(A('Oct 3, 2026 at 4:11 PM'))!;
    expect(a).toMatchObject({ amountCents: -1230, vendor: 'SQ *CAFE', occurredOn: '2026-10-03' });
    expect(a.authorizedAtUtc).toBe('2026-10-03T20:11:00.000Z'); // EDT = UTC-4
  });
  it('DST is judged at the alert\'s own date, not at run time', () => {
    expect(parseChaseAlert(A('Nov 2, 2026 at 9:00 AM'))!.authorizedAtUtc).toBe('2026-11-02T14:00:00.000Z'); // EST = UTC-5 (after Nov 1, 2026)
    expect(parseChaseAlert(A('Oct 31, 2026 at 9:00 AM'))!.authorizedAtUtc).toBe('2026-10-31T13:00:00.000Z'); // still EDT
    expect(parseChaseAlert(A('Mar 14, 2027 at 9:00 AM'))!.authorizedAtUtc).toBe('2027-03-14T13:00:00.000Z'); // EDT again from Mar 14, 2027
    expect(parseChaseAlert(A('Mar 13, 2027 at 9:00 AM'))!.authorizedAtUtc).toBe('2027-03-13T14:00:00.000Z');
  });
  it('an Eastern late-night alert lands on the previous Pacific day only when it crosses midnight there', () => {
    expect(parseChaseAlert(A('Oct 4, 2026 at 12:30 AM'))!.occurredOn).toBe('2026-10-03'); // 9:30 PM Pacific on the 3rd
    expect(parseChaseAlert(A('Oct 4, 2026 at 3:30 AM'))!.occurredOn).toBe('2026-10-04');
  });
  it('reads the sentence inside an email body and tolerates amounts with commas', () => {
    const a = parseChaseAlert(`Hello,\nPrime Visa: You made a $1,204.99 transaction with DELTA AIR LINES on October 3, 2026 at 16:11 ET.\nThanks`)!;
    expect(a.amountCents).toBe(-120499);
    expect(parseChaseAlert('some other message')).toBeNull();
  });
});

describe('chase alert -> provisional txn -> posted', () => {
  it('creates a provisional transaction, classifies it, is replay-safe, and the CSV row supersedes it keeping the answer', () => {
    const h = seedHousehold();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'cafe' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
    const ev = captureEvent(h.db, { source: 'chase_alert', channel: 'device', payload: A('Oct 3, 2026 at 4:11 PM') });
    expect(captureEvent(h.db, { source: 'chase_alert', channel: 'device', payload: A('Oct 3, 2026 at 4:11 PM') }).duplicate).toBe(true); // both phones
    replay(h.db);
    replay(h.db, { includeOk: true });
    const t = h.db.prepare("SELECT * FROM transactions WHERE status='provisional'").all() as any[];
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ amount_cents: -1230, review_state: 'auto_categorized', account_id: h.chase });
    // the posted row arrives by CSV two days later with the same amount: it supersedes the provisional one
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n10/03/2026,10/05/2026,SQ *CAFE SEATTLE WA,Food,Sale,-12.30,\n';
    const m = suggestMapping(parseCsv(csv));
    const r = commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 });
    expect(r.supersededProvisionals).toBe(1);
    const live = h.db.prepare("SELECT t.status, s.category_id FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.status!='void'").all() as any[];
    expect(live).toEqual([{ status: 'posted', category_id: h.cats['Eating Out'] }]);
  });
  it('a tip changes the posted amount: tolerance matching still pairs them when unambiguous', () => {
    const h = seedHousehold();
    captureEvent(h.db, { source: 'chase_alert', channel: 'device', payload: A('Oct 3, 2026 at 7:00 PM', 'EL RINCONSITO', '20.00') });
    replay(h.db);
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n10/03/2026,10/05/2026,EL RINCONSITO SEATTLE WA,Food,Sale,-24.00,\n';
    const m = suggestMapping(parseCsv(csv));
    expect(commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }).supersededProvisionals).toBe(1);
  });
  it('an unknown shape stays unrecognized and creates nothing', () => {
    const h = seedHousehold();
    captureEvent(h.db, { source: 'chase_alert', channel: 'email', payload: 'Your statement is ready' });
    expect(replay(h.db).byStatus.unrecognized).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });
});

describe('late alert after posted row', () => {
  it('does not create a second transaction when the CSV already posted the charge', async () => {
    const { seedHousehold } = await import('./helpers.js');
    const { createTransaction } = await import('../src/core/transactions.js');
    const { captureEvent, parseEvent, clearParsers } = await import('../src/ingest/events.js');
    const { registerAllParsers } = await import('../src/ingest/parsers.js');
    const h = seedHousehold(); clearParsers(); registerAllParsers();
    createTransaction(h.db, { accountId: h.chase, status: 'posted', occurredOn: '2026-10-03', amountCents: -940, descriptor: 'SQ *LATE CAFE #123' });
    parseEvent(h.db, captureEvent(h.db, { source: 'chase_alert', channel: 'device', payload: 'Prime Visa: You made a $9.40 transaction with SQ *LATE CAFE on Oct 3, 2026 at 4:11 PM ET.' }).id);
    expect(h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE amount_cents=-940").get()).toEqual({ c: 1 });
  });
});
