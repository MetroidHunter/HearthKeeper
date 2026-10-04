import { describe, it, expect } from 'vitest';
import { openDb } from '../src/core/db.js';
import { addCategory, setBudget, retireCategory, budgetHistory } from '../src/core/categories.js';
import { categoryBalance, accrued, periodTotals, checkInvariants } from '../src/core/balance.js';
import { parseCents } from '../src/core/money.js';

function acct(db: any) { return Number(db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Chase','Chase','credit_card')").run().lastInsertRowid); }
function txn(db: any, a: number, date: string, cents: number, cat: number | null, kind = 'spending') {
  const id = Number(db.prepare('INSERT INTO transactions(account_id,kind,occurred_on,amount_cents) VALUES (?,?,?,?)').run(a, kind, date, cents).lastInsertRowid);
  db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents) VALUES (?,?,?)').run(id, cat, cents);
  return id;
}

describe('money', () => {
  it('parses', () => {
    expect(parseCents('-150.00')).toBe(-15000);
    expect(parseCents('-150')).toBe(-15000);
    expect(parseCents('($1,234.5)')).toBe(-123450);
    expect(parseCents('0.07')).toBe(7);
  });
});

describe('accrual', () => {
  it('uses effective-dated versions, inclusive of current month', () => {
    const v = [{ effective_month: '2024-01', monthly_cents: 10000 }, { effective_month: '2024-04', monthly_cents: 20000 }];
    expect(accrued('2024-01', v, '2024-03-15')).toBe(30000);
    expect(accrued('2024-01', v, '2024-04-01')).toBe(50000);
    expect(accrued('2024-06', v, '2024-05-01')).toBe(0);
  });
});

describe('balance', () => {
  it('= splits + transfers + accrual; retire preserves history', () => {
    const db = openDb();
    const a = acct(db);
    const g = addCategory(db, { name: 'Groceries', group: 'Food', startMonth: '2024-01', monthlyCents: 100000 });
    const e = addCategory(db, { name: 'Eating Out', group: 'Food', startMonth: '2024-01', monthlyCents: 20000 });
    txn(db, a, '2024-01-10', -30000, g);
    txn(db, a, '2024-02-10', 5000, g); // refund
    const t = Number(db.prepare("INSERT INTO envelope_transfers(occurred_on,kind) VALUES ('2024-02-28','reconcile')").run().lastInsertRowid);
    db.prepare('INSERT INTO envelope_transfer_legs(transfer_id,category_id,amount_cents) VALUES (?,?,?)').run(t, g, -10000);
    db.prepare('INSERT INTO envelope_transfer_legs(transfer_id,category_id,amount_cents) VALUES (?,?,?)').run(t, e, 10000);
    expect(categoryBalance(db, g, '2024-02-29').total).toBe(200000 - 30000 + 5000 - 10000);
    expect(categoryBalance(db, e, '2024-02-29').total).toBe(40000 + 10000);
    expect(periodTotals(db, g, '2024-01-01', '2024-02-29')).toEqual({ spent: 25000, gained: 0 }); // refund reduces spent (D13)
    expect(periodTotals(db, g, '2024-01-01', '2024-02-29', { sheetCompatible: true })).toEqual({ spent: 30000, gained: 5000 });
    setBudget(db, e, 30000, '2024-03');
    expect(budgetHistory(db, e).map((h) => [h.effective_month, h.from_cents, h.monthly_cents])).toEqual([['2024-01', null, 20000], ['2024-03', 20000, 30000]]);
    expect(retireCategory(db, e, '2024-04', { asOf: '2024-04-30' }).remainingCents).toBe(20000 * 2 + 30000 + 10000);
    expect(checkInvariants(db)).toEqual([]);
  });
});
