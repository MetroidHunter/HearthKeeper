import { describe, it, expect } from 'vitest';
import { formatCents } from '../src/core/money.js';
import { seedHousehold } from './helpers.js';
import { addCategory } from '../src/core/categories.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { noteOverage, openNotices } from '../src/core/notices.js';

describe('formatCents rounds to whole cents', () => {
  it('prints fractional cents (legacy budgets like 400/12) as a clean amount, never "$49.19.77"', () => {
    expect(formatCents(-4919.773092000046745)).toBe('-$49.20');
    expect(formatCents(4919.4)).toBe('$49.19');
    expect(formatCents(1234567.5)).toBe('$12,345.68');
    expect(formatCents(99.5)).toBe('$1.00'); // rolls over into the next dollar
  });
  it('whole cents are unchanged, and a rounded-away amount is not "-$0.00"', () => {
    expect(formatCents(8391)).toBe('$83.91'); expect(formatCents(-5)).toBe('-$0.05'); expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-0.2)).toBe('$0.00');
  });
});

describe('the over-budget heads-up', () => {
  it('reads cleanly when the envelope has a fractional-cent budget', () => {
    const h = seedHousehold();
    const cat = addCategory(h.db, { name: 'Makeup', group: 'Personal', startMonth: '2026-10', monthlyCents: 5000.4, kind: 'expense' });
    const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-14', amountCents: -8391, descriptor: 'SEPHORA SOUTHCENTER' });
    setSplits(h.db, id, [{ categoryId: cat, amountCents: -8391 }], 'rule');
    noteOverage(h.db, id, cat);
    const msg = (openNotices(h.db) as any[])[0].message as string;
    expect(msg).toBe('Makeup is $33.91 over budget after SEPHORA SOUTHCENTER ($83.91).');
  });
  it('a notice already stored with a garbled amount, in the old long wording, is shown repaired and shortened', () => {
    const h = seedHousehold();
    const cat = h.cats['Groceries'];
    h.db.prepare("INSERT INTO notices(kind, category_id, txn_id, message) VALUES ('over_budget', ?, NULL, ?)").run(cat, 'Makeup went over budget: -$49.19.773092000046745 left in it after SEPHORA SOUTHCENTER ($83.91) was filed there automatically.');
    expect((openNotices(h.db) as any[])[0].message).toBe('Makeup is $49.20 over budget after SEPHORA SOUTHCENTER ($83.91).'); // and in the shorter wording
  });
  it('a notice stored in the old long wording with clean amounts is shortened too', () => {
    const h = seedHousehold();
    h.db.prepare("INSERT INTO notices(kind, category_id, txn_id, message) VALUES ('over_budget', ?, NULL, ?)").run(h.cats['Groceries'], 'Eating Out went over budget: -$40.00 left in it after BIGSHOP 1 ($50.00) was filed there automatically.');
    expect((openNotices(h.db) as any[])[0].message).toBe('Eating Out is $40.00 over budget after BIGSHOP 1 ($50.00).');
  });
});
