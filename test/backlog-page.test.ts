import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { backlogPage } from '../src/core/backlog.js';
import { inbox } from '../src/core/reports.js';
import { createTransaction, classify, setSplits } from '../src/core/transactions.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { buildApp } from '../src/server/app.js';

const TODAY = '2026-10-07';
function world(shops = 30) {
  const h = seedHousehold();
  const day = new Date().toISOString().slice(0, 10); // some categorized history, so there is something to suggest
  for (let i = 0; i < 4; i++) { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -1000 - i, descriptor: `HISTORY ${i}` }); setSplits(h.db, id, [{ categoryId: h.cats['Groceries'], amountCents: -1000 - i }], 'user'); }
  // shop i has (shops - i) transactions, so the order by size is known; all uncategorized
  for (let i = 0; i < shops; i++) for (let k = 0; k < shops - i; k++) { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: `2026-09-${String(1 + (k % 28)).padStart(2, '0')}`, amountCents: -(500 + k), descriptor: `SHOP${String(i).padStart(2, '0')} UNIQUE` }); classify(h.db, id); }
  return h;
}

describe('backlogPage (the paged Backlog)', () => {
  it('pages merchants, biggest group first, and only does the per-row work for the page it returns', () => {
    const h = world(30);
    const p1 = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, today: TODAY });
    expect(p1.total).toBe(30); expect(p1.totalTxns).toBe((30 * 31) / 2); expect(p1.groups).toHaveLength(10);
    expect(p1.groups.map((g) => g.count)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
    const p3 = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 20, today: TODAY });
    expect(p3.groups.map((g) => g.count)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(p1.counts.needsCategory).toBe((30 * 31) / 2);
    const g = p1.groups[0]; expect(g.items).toHaveLength(30); // up to 50 rows per group are sent
    expect(g.items.every((t: any) => t.reasons.some((r: any) => r.reason === 'needs_category') && Array.isArray(t.suggestions))).toBe(true);
    expect(g.suggestions.length).toBeGreaterThan(0); expect(g.items[0].suggestions).toEqual(g.suggestions); // one lookup per group, shared by its rows
    expect(backlogPage(h.db, { view: 'merchants', limit: 10, offset: 500, today: TODAY }).groups).toEqual([]); // past the end is empty, not an error
  });

  it('a big group sends at most 50 rows but says how many there really are, and one answer still covers all of them', () => {
    const h = world(2); // 2 shops: 2 and 1 transactions
    for (let k = 0; k < 80; k++) { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-08-15', amountCents: -(100 + k), descriptor: 'BIG GROUP 123' }); classify(h.db, id); }
    const big = backlogPage(h.db, { view: 'merchants', limit: 5, offset: 0, today: TODAY }).groups[0];
    expect(big.count).toBe(80); expect(big.items).toHaveLength(50); expect(big.txnIds).toHaveLength(80);
  });

  it('searches merchants by name, and a transaction with several open reasons carries all of them', () => {
    const h = world(5);
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-09-30', amountCents: -999, descriptor: 'AMZN Mktp US*FLAGGED1' }); classify(h.db, id);
    h.db.prepare("UPDATE transactions SET flagged=1, flag_reason='check', note_state='needs_note' WHERE id=?").run(id);
    const r = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, q: 'amazon', today: TODAY });
    expect(r.total).toBe(1); const item = r.groups[0].items[0];
    expect(item.reasons.map((x: any) => x.reason).sort()).toEqual(['flagged', 'needs_category', 'needs_note']);
    expect(backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, q: 'zzz-nothing', today: TODAY }).total).toBe(0);
  });

  it('flagged and notes tabs page by transaction, newest first, with a search', () => {
    const h = seedHousehold();
    for (let i = 0; i < 60; i++) { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, amountCents: -(100 + i), descriptor: i % 2 ? `PAYPAL *THING${i}` : `AMZN Mktp US*T${i}` });
      setSplits(h.db, id, [{ categoryId: h.cats['Groceries'], amountCents: -(100 + i) }], 'user'); h.db.prepare("UPDATE transactions SET note_state='awaiting_note', flagged=? WHERE id=?").run(i < 7 ? 1 : 0, id); }
    const n1 = backlogPage(h.db, { view: 'notes', limit: 25, offset: 0, today: TODAY }); const n3 = backlogPage(h.db, { view: 'notes', limit: 25, offset: 50, today: TODAY });
    expect([n1.total, n1.items.length, n3.items.length]).toEqual([60, 25, 10]);
    const dates = n1.items.map((t: any) => t.occurred_on); expect([...dates].sort().reverse()).toEqual(dates);
    expect(backlogPage(h.db, { view: 'notes', limit: 25, offset: 0, q: 'paypal', today: TODAY }).total).toBe(30);
    expect(backlogPage(h.db, { view: 'flagged', limit: 25, offset: 0, today: TODAY }).total).toBe(7);
    expect(n1.items.every((t: any) => t.reasons.some((r: any) => r.reason === 'needs_note'))).toBe(true);
  });

  it('inbox(limit) only computes suggestions for the rows it returns, but the counts stay true', () => {
    const h = world(10);
    const all = inbox(h.db, TODAY); const few = inbox(h.db, TODAY, { limit: 5 });
    expect(few.counts).toEqual(all.counts); expect(few.items).toHaveLength(5); expect(all.items.length).toBeGreaterThan(5);
    expect(few.items.every((t: any) => t.suggestions.length > 0)).toBe(true);
    expect(few.needsCategory.filter((t: any) => t.suggestions.length).length).toBe(5);
  });
});

describe('a CSV import flags Amazon / Venmo / PayPal charges as waiting for a note straight away', () => {
  it('reports how many, and they are on the Waiting-on-notes list without waiting for the timer', () => {
    const h = seedHousehold();
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' + [
      '09/03/2026,09/04/2026,AMZN Mktp US*2K4LM9,Shopping,Sale,-23.99,', '09/05/2026,09/06/2026,AMAZON.COM*1AB2CD,Shopping,Sale,-12.50,',
      '09/07/2026,09/08/2026,PAYPAL *NY TIMES,Shopping,Sale,-30.00,', '09/09/2026,09/10/2026,VENMO PAYMENT 1234,Shopping,Sale,-15.00,', '09/11/2026,09/12/2026,TRADER JOES #1,Groceries,Sale,-44.00,'].join('\n') + '\n';
    const m = suggestMapping(parseCsv(csv));
    const r = commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }, { accountId: h.chase });
    expect(r.imported).toBe(5); expect(r.waitingOnNotes).toBe(4);
    const notes = backlogPage(h.db, { view: 'notes', limit: 25, offset: 0, today: TODAY });
    expect(notes.total).toBe(4); expect(notes.counts.needsNote).toBe(4);
    expect(notes.items.map((t: any) => t.descriptor_raw).sort()).toEqual(['AMAZON.COM*1AB2CD', 'AMZN Mktp US*2K4LM9', 'PAYPAL *NY TIMES', 'VENMO PAYMENT 1234']);
  });
  it('a note that already arrived by email attaches during the import', () => {
    const h = seedHousehold();
    h.db.prepare("INSERT INTO external_notes(source, occurred_on, amount_cents, note) VALUES ('amazon','2026-09-03',-2399,'cat food,shampoo')").run();
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n09/04/2026,09/05/2026,AMZN Mktp US*2K4LM9,Shopping,Sale,-23.99,\n'; const m = suggestMapping(parseCsv(csv));
    const r = commitImport(h.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }, { accountId: h.chase });
    expect(r.notesMatched).toBe(1); expect(r.waitingOnNotes).toBe(0);
    expect(h.db.prepare("SELECT note, note_state s FROM transactions WHERE descriptor_raw LIKE 'AMZN%'").get()).toEqual({ note: 'cat food,shampoo', s: 'auto_matched' });
  });
});

describe('GET /api/backlog', () => {
  it('validates the view and clamps paging', async () => {
    const h = world(15); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, now: () => TODAY });
    expect((await app.inject({ url: '/api/backlog?view=bogus' })).statusCode).toBe(400);
    const r = (await app.inject({ url: '/api/backlog?limit=9999&offset=-5' })).json();
    expect(r.groups.length).toBe(15); expect(r.view).toBe('merchants'); // default view, limit clamped to 100, negative offset treated as 0
    expect((await app.inject({ url: '/api/backlog?limit=3&offset=3' })).json().groups.map((g: any) => g.count)).toEqual([12, 11, 10]);
    expect((await app.inject({ url: '/api/inbox?limit=3' })).json().items).toHaveLength(3);
  });
});
