import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction } from '../src/core/transactions.js';
import { importNotesCsv, runNoteMatcher, noteQuality, allocateToCharge, findSubsets, proposeItemSplits, assign } from '../src/notes/matcher.js';
import { addRule } from '../src/core/rules.js';

const tx = (h: any, d: string, c: number, desc: string) => createTransaction(h.db, { accountId: h.chase, occurredOn: d, amountCents: c, descriptor: desc });

describe('notes matcher', () => {
  it('source-aware: an Amazon and a Venmo charge of the same amount no longer compete', () => {
    const h = seedHousehold();
    const a = tx(h, '2026-10-02', -2399, 'AMZN Mktp US*2K4LM9');
    const v = tx(h, '2026-10-04', -2399, 'VENMO PAYMENT 1234 BRYS SEPULVEDA');
    importNotesCsv(h.db, 'Date,Amount,Note\n10/01/2026,-23.99,"bags,cardstock"\n10/02/2026,-23.99,Dinner with Sam 🍕🍝\n', 'amazon');
    h.db.prepare("UPDATE external_notes SET source='venmo' WHERE note LIKE 'Dinner%'").run();
    const r = runNoteMatcher(h.db);
    expect(r.matched).toBe(2);
    expect((h.db.prepare('SELECT note FROM transactions WHERE id=?').get(a) as any).note).toBe('bags,cardstock');
    expect((h.db.prepare('SELECT note, note_state FROM transactions WHERE id=?').get(v) as any)).toEqual({ note: 'Dinner with Sam 🍕🍝', note_state: 'auto_matched' });
  });

  it('global assignment resolves same-amount rows without stealing candidates; true ties become ambiguous (a state, not text)', () => {
    const h = seedHousehold();
    const t1 = tx(h, '2026-10-03', -1000, 'AMAZON.COM*AAA');
    const t2 = tx(h, '2026-10-05', -1000, 'AMAZON.COM*BBB');
    importNotesCsv(h.db, 'Date,Amount,Note\n10/03/2026,-10.00,first\n10/05/2026,-10.00,second\n', 'amazon');
    runNoteMatcher(h.db);
    expect((h.db.prepare('SELECT note FROM transactions WHERE id=?').get(t1) as any).note).toBe('first');
    expect((h.db.prepare('SELECT note FROM transactions WHERE id=?').get(t2) as any).note).toBe('second');
    const t3 = tx(h, '2026-10-10', -777, 'PAYPAL *VENDOR');
    importNotesCsv(h.db, 'Date,Amount,Note\n10/09/2026,-7.77,a\n10/11/2026,-7.77,b\n', 'paypal');
    runNoteMatcher(h.db);
    expect((h.db.prepare('SELECT note_state FROM transactions WHERE id=?').get(t3) as any).note_state).toBe('ambiguous');
    runNoteMatcher(h.db); // re-running is not blocked
  });

  it('venmo asymmetric window and vague emoji notes', () => {
    const h = seedHousehold();
    const t = tx(h, '2026-10-02', -500, 'VENMO PAYMENT');
    importNotesCsv(h.db, 'Date,Amount,Note\n10/05/2026,-5.00,🍕\n', 'venmo'); // note after bank date: outside window
    expect(runNoteMatcher(h.db).matched).toBe(0);
    importNotesCsv(h.db, 'Date,Amount,Note,Counterparty\n09/30/2026,-5.00,🍕,Sam\n', 'venmo');
    const r = runNoteMatcher(h.db);
    expect(r.needsNote).toBe(1);
    expect((h.db.prepare('SELECT note_state, flag_reason FROM transactions WHERE id=?').get(t) as any).flag_reason).toContain('Sam');
    expect(noteQuality('🍕')).toBe('vague'); expect(noteQuality('🍕🍝🍷')).toBe('sufficient'); expect(noteQuality('')).toBe('none'); expect(noteQuality('rent')).toBe('sufficient');
  });

  it('points-paid phantom rows are dropped before matching; Venmo cashouts need no note', () => {
    const h = seedHousehold();
    const r = importNotesCsv(h.db, 'Date,Amount,Note,Payment\n10/01/2026,-9.99,thing,Amazon points\n10/01/2026,-9.99,thing,Visa 1234\n', 'amazon');
    expect(r).toMatchObject({ imported: 1, skippedPhantom: 1 });
    const c = createTransaction(h.db, { accountId: h.wf, kind: 'income', occurredOn: '2026-10-02', amountCents: 20000, descriptor: 'VENMO CASHOUT 261002 MIRACLE' });
    runNoteMatcher(h.db);
    expect((h.db.prepare('SELECT note_state FROM transactions WHERE id=?').get(c) as any).note_state).toBe('not_needed');
  });

  it('hungarian assignment finds the optimum', () => { expect(assign([[1, 2], [1, 100]])).toEqual([1, 0]); });
});

describe('item-level splits', () => {
  it('allocates tax/shipping proportionally with remainder to the largest item', () => {
    expect(allocateToCharge([{ name: 'a', cents: 1899 }, { name: 'b', cents: 1149 }], 3300)).toEqual([2056, 1244].map((x, i) => x)); // sums to 3300
    expect(allocateToCharge([{ name: 'a', cents: 1899 }, { name: 'b', cents: 1149 }], 3300).reduce((a, b) => a + b)).toBe(3300);
  });
  it('multi-shipment: finds item subsets matching the charge', () => {
    const items = [{ name: 'a', cents: 1000 }, { name: 'b', cents: 2000 }, { name: 'c', cents: 4000 }];
    expect(findSubsets(items, 7700, 3300)).toEqual([[0, 1]]); // $30 of items + 10% tax/shipping = 33.00
    expect(findSubsets([...items, { name: 'd', cents: 3000 }], 11000, 3300).length).toBe(2); // two clean subsets => user picks
  });
  it('proposes splits using item rules; unmatched items prompt (null category)', () => {
    const h = seedHousehold();
    h.db.prepare("INSERT INTO categories(name,kind,start_month) VALUES ('Pets','expense','2026-01')").run();
    addRule(h.db, { match: { all_of: [{ field: 'item_name', op: 'contains', value: 'cat litter' }] }, action: { type: 'categorize', category: 'Pets' }, mode: 'suggest' });
    const t = tx(h, '2026-10-02', -3000, 'AMZN Mktp');
    importNotesCsv(h.db, 'Date,Amount,Note,Items\n10/02/2026,-30.00,"cat litter,paper towels","cat litter|1|18.99;paper towels|1|11.49"\n', 'amazon');
    runNoteMatcher(h.db);
    const p = proposeItemSplits(h.db, t)!;
    expect(p.items.map((i) => i.cents).reduce((a, b) => a + b)).toBe(-3000);
    expect(p.items[0].categoryId).not.toBeNull();
    expect(p.items[1].categoryId).toBeNull();
  });
});

describe('Amazon notes export with unsigned amounts', () => {
  it("matches the skill's CSV (positive amounts) to negative bank charges, and does not take UNKNOWN as a note", () => {
    const h = seedHousehold();
    const a = tx(h, '2026-10-02', -4085, 'AMZN Mktp US*1AB'), b = tx(h, '2026-09-20', -3011, 'AMAZON.COM*XYZ'), c = tx(h, '2026-09-30', -1100, 'Amazon.com*Q1');
    const csv = 'Date,Amount,Note\n2026-10-01,40.85,"skirt,deodorant,bow tie"\n2026-09-30,11.00,glitter makeup\n2026-09-20,30.11,"UNKNOWN - no order number on Payments page"\n';
    const imp = importNotesCsv(h.db, csv, 'amazon'); expect(imp.imported).toBe(3);
    const r = runNoteMatcher(h.db);
    expect(r.matched).toBe(2);
    const row = (id: number) => h.db.prepare('SELECT note, note_state, flag_reason FROM transactions WHERE id=?').get(id) as any;
    expect(row(a)).toMatchObject({ note: 'skirt,deodorant,bow tie', note_state: 'auto_matched' });
    expect(row(c)).toMatchObject({ note: 'glitter makeup', note_state: 'auto_matched' });
    expect(row(b)).toMatchObject({ note: null, note_state: 'needs_note' });
    expect(row(b).flag_reason).toMatch(/could not identify/);
    // a signed export (negative amounts) still works, and an exact-sign match wins over a wrong-sign one of the same size
    const h2 = seedHousehold(); const x = tx(h2, '2026-10-02', -500, 'AMZN Mktp US*9');
    importNotesCsv(h2.db, 'Date,Amount,Note\n2026-10-01,5.00,wrong sign\n2026-10-01,-5.00,right sign\n', 'amazon');
    expect(runNoteMatcher(h2.db).matched).toBe(1);
    expect((h2.db.prepare('SELECT note FROM transactions WHERE id=?').get(x) as any).note).toBe('right sign');
  });
});
