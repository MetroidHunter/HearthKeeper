import { describe, it, expect } from 'vitest';
import { openDb } from '../src/core/db.js';
import { importSheets } from '../src/migration/sheet.js';
import { worksheetItems, applyWorksheet, loadReport } from '../src/migration/worksheet.js';
import { bootstrapMerchants } from '../src/migration/merchants.js';
import { categoryBalance, checkInvariants } from '../src/core/balance.js';
import { addRule } from '../src/core/rules.js';

const LIST = 'Name,Parent,Start Date,Deprecated\nGig Income,Income,1/1/2024,\nGroceries,Food,1/1/2024,\nEating Out,Food,1/1/2024,\nNEEDS CATEGORY,Goods,1/1/2024,\n';
const HIST = 'Budget Name,Budget,Month Stopped Using\n';
const BUD = 'Parent Budget,Budget Name,Budget,Current\nIncome,Gig Income,0,\nFood,Groceries,100,\nFood,Eating Out,100,\nGoods,NEEDS CATEGORY,0,\n';
const TX = `Date,Name,Charge,Category,Split Total,Notes
5/9/2025,ZELLE FROM PREMIER VOCAL ENTERTAINMENT ON 05/09 REF # ABC,300,NEEDS CATEGORY,,
5/10/2025,SAFEWAY #1551,-45.25,NEEDS CATEGORY,,
5/11/2025,MYSTERY CHARGE,-12.34,,,
5/12/2025,SAFEWAY #1551,-20,Groceries,,
5/13/2025,SAFEWAY #22,-30,Groceries,,
5/14/2025,SAFEWAY #1551,-10,Groceries,,
`;

describe('migration worksheet (D32)', () => {
  const db = openDb();
  importSheets(db, { list: LIST, history: HIST, budget: BUD, transactions: TX });
  addRule(db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'premier vocal' }] }, action: { type: 'categorize', category: 'Gig Income' }, mode: 'suggest' });
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name=?').get(n) as any).id;

  it('persists the data-quality report from the import', () => { const r = loadReport(db); expect(r.needsCategoryRows).toBe(2); expect(r.blankCategoryRows).toBe(1); });

  it('lists every leftover with ranked suggestions (rule first, then history)', () => {
    bootstrapMerchants(db);
    const items = worksheetItems(db);
    expect(items).toHaveLength(3);
    const zelle = items.find((i) => /PREMIER/.test(i.descriptor))!;
    expect(zelle.bucket).toBe('NEEDS CATEGORY');
    expect(zelle.suggestions[0]).toMatchObject({ name: 'Gig Income', why: 'rule' });
    const safeway = items.find((i) => /SAFEWAY/.test(i.descriptor))!;
    expect(safeway.suggestions.map((s) => s.name)).toContain('Groceries'); // learned from the three categorized Safeway rows
    expect(items.find((i) => /MYSTERY/.test(i.descriptor))!.bucket).toBe('(blank)');
  });

  it('applies assignments atomically and reports before/after balances for every category touched', () => {
    const items = worksheetItems(db);
    const g0 = categoryBalance(db, cat('Groceries'), '2025-12-31').total!, gig0 = categoryBalance(db, cat('Gig Income'), '2025-12-31').total!;
    const res = applyWorksheet(db, [
      { splitId: items.find((i) => /SAFEWAY/.test(i.descriptor))!.splitId, categoryId: cat('Groceries') },
      { splitId: items.find((i) => /PREMIER/.test(i.descriptor))!.splitId, categoryId: cat('Gig Income') },
      { splitId: 999999, categoryId: cat('Groceries') }, // unknown split: skipped, not fatal
    ], '2025-12-31');
    expect(res).toMatchObject({ applied: 2, skipped: 1 });
    const gr = res.balances.find((b) => b.name === 'Groceries')!;
    expect(gr.before).toBe(g0); expect(gr.after).toBe(g0 - 4525);
    expect(res.balances.find((b) => b.name === 'Gig Income')!.after).toBe(gig0 + 30000);
    expect(res.pseudoAfter - res.pseudoBefore).toBe(-(30000 - 4525)); // what left the NEEDS CATEGORY pseudo-bucket
    expect(worksheetItems(db)).toHaveLength(1); // only the blank-category row remains
    expect(checkInvariants(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='migration_worksheet'").get()).toEqual({ c: 1 });
  });

  it('merchant bootstrap clusters descriptors, links history, creates only unreviewed merchants, and proposes merges', () => {
    const r = bootstrapMerchants(db);
    expect(r.merchantsCreated).toBe(0); // already bootstrapped above: idempotent
    const m = db.prepare("SELECT name, review_state FROM merchants WHERE name LIKE 'SAFEWAY%'").all() as any[];
    expect(m.length).toBe(1); expect(m[0].review_state).toBe('unreviewed');
    expect(db.prepare("SELECT COUNT(*) c FROM transactions t JOIN merchants m ON m.id=t.merchant_id WHERE m.name='SAFEWAY'").get()).toEqual({ c: 4 });
  });
});

import { groupedInbox, bulkAnswer } from '../src/core/backlog.js';
import { seedHousehold } from './helpers.js';
import { createTransaction, classify, setSplits } from '../src/core/transactions.js';
describe('backlog mode', () => {
  it('groups by merchant, applies one answer to the whole group, never overwrites a human decision, and learns a rule', () => {
    const h = seedHousehold();
    const mk = (d: string, c: number) => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: c, descriptor: d }); classify(h.db, id); return id; };
    const a = [mk('SQ *CORNER BAKERY SEATTLE WA', -500), mk('SQ *CORNER BAKERY SEATTLE WA', -700), mk('SQ *CORNER BAKERY SEATTLE WA', -900)];
    mk('RANDOM SHOP', -100);
    setSplits(h.db, a[2], [{ categoryId: h.cats['Groceries'], amountCents: -900 }], 'user'); // answered by a human meanwhile
    const g = groupedInbox(h.db);
    expect(g[0]).toMatchObject({ name: 'CORNER BAKERY', count: 2, totalCents: -1200 });
    const r = bulkAnswer(h.db, [...g[0].txnIds, a[2]], h.cats['Eating Out'], { rule: { match: { all_of: [{ field: 'merchant', op: 'eq', value: 'CORNER BAKERY' }] }, mode: 'suggest' } });
    expect(r).toMatchObject({ applied: 2, skipped: 1 });
    expect(r.rule!.backtest.matched).toBeGreaterThanOrEqual(2);
    expect((h.db.prepare('SELECT category_id c FROM transaction_splits WHERE transaction_id=?').get(a[2]) as any).c).toBe(h.cats['Groceries']);
    expect(groupedInbox(h.db).map((x) => x.name)).toEqual(['RANDOM SHOP']);
  });
});
