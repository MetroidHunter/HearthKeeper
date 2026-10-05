import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { openDb } from '../src/core/db.js';
import { importSheets } from '../src/migration/sheet.js';
import { runParity, formatParity } from '../src/migration/parity.js';
import { checkInvariants } from '../src/core/balance.js';

// Runs only where the (gitignored) export of the real sheet exists: `python3 tools/xlsx_to_export.py private/BudgetProgram.xlsx private/export`
const dir = new URL('../private/export/', import.meta.url);
const have = existsSync(new URL('Transactions.csv', dir));
const rd = (n: string) => (existsSync(new URL(n, dir)) ? readFileSync(new URL(n, dir), 'utf8') : undefined);

describe.skipIf(!have)('real BudgetProgram export (private)', () => {
  let db: ReturnType<typeof openDb>;
  let rep: ReturnType<typeof importSheets>;
  beforeAll(() => { // inside beforeAll: a skipped describe body still executes at collection time
    db = openDb();
    rep = importSheets(db, { list: rd('List.csv')!, history: rd('History.csv')!, budget: rd('Budget.csv')!, transactions: rd('Transactions.csv')! });
  }, 120_000);
  it('imports without errors', () => { expect(rep.errors).toEqual([]); expect(rep.transactionsImported + rep.legacyLegsImported).toBe(Number(rd('oracle_txn_count.txt'))); });
  it('P1-P7: matches the sheet\'s own computed cells to within half a cent, zero unexplained', () => {
    const r = runParity(db, '2026-10-04', { internalAB: rd('oracle_internal_AB.csv'), internalHJ: rd('oracle_internal_HJ.csv'), budgetCurrent: rd('oracle_budget_current.csv'), periods: rd('oracle_periods.csv'), periodsMonth: rd('oracle_periods_month.txt')?.trim(),
      allocated: rd('oracle_allocated.txt'), txnCount: Number(rd('oracle_txn_count.txt')), txnTotal: rd('oracle_txn_total.txt')?.trim() });
    expect(r.checks.length).toBeGreaterThan(500);
    expect(formatParity(r)).toContain('PASS');
  });
  it('invariants hold on the migrated data', () => { expect(checkInvariants(db)).toEqual([]); });
}, 120_000);
