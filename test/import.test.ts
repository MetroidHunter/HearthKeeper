import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { previewImport, commitImport, coverage } from '../src/ingest/import.js';
import { addRule } from '../src/core/rules.js';
import { createTransaction } from '../src/core/transactions.js';
import { pairTransfers } from '../src/ingest/pairing.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';

const CHASE = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2026,10/02/2026,SEPHORA #182 SEATTLE WA,Shopping,Sale,-42.10,
10/01/2026,10/02/2026,STARBUCKS #55,Food,Sale,-5.00,
10/01/2026,10/02/2026,STARBUCKS #55,Food,Sale,-5.00,
10/03/2026,10/03/2026,PAYMENT THANK YOU - WEB,,Payment,500.00,
`;
const WF = `10/03/2026,-500.00,*,,CHASE CREDIT CRD AUTOPAY 261003 1234
10/04/2026,-80.00,*,,RECURRING TRANSFER TO WAY2SAVE SAVINGS
`;

describe('CSV import', () => {
  it('first upload suggests a mapping; a saved profile makes later uploads zero-format', () => {
    const h = seedHousehold();
    const p = previewImport(h.db, 'Chase', CHASE);
    expect(p.profileId).toBeNull();
    expect(p.suggested?.columnMap).toMatchObject({ date: 'Transaction Date', amount: 'Amount', description: 'Description', hasHeader: true });
    const spec = { columnMap: p.suggested!.columnMap, dateFormat: p.suggested!.dateFormat, signRule: p.suggested!.signRule, skipRows: 0 };
    const pv = previewImport(h.db, 'Chase', CHASE, spec);
    expect(pv).toMatchObject({ total: 4, new: 4, alreadyImported: 0 });
    expect(previewImport(h.db, 'Chase', CHASE).profileId).not.toBeNull();
  });

  it('multiset de-dup: identical coffees preserved, re-import and wide overlap are harmless', () => {
    const h = seedHousehold();
    const s = suggestMapping(parseCsv(CHASE));
    const spec = { columnMap: s.columnMap, dateFormat: s.dateFormat, signRule: s.signRule, skipRows: 0 };
    const r1 = commitImport(h.db, 'Chase', CHASE, spec);
    expect(r1.imported).toBe(4);
    expect((h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE descriptor_raw LIKE 'STARBUCKS%'").get() as any).c).toBe(2);
    expect(commitImport(h.db, 'Chase', CHASE).imported).toBe(0);
    const wider = CHASE + '10/05/2026,10/05/2026,STARBUCKS #55,Food,Sale,-5.00,\n';
    const r3 = commitImport(h.db, 'Chase', wider);
    expect(r3.imported).toBe(1); // M=3 rows with that fingerprint? no: different date; only the new one
  });

  it('headerless Wells Fargo layout maps by index; card payment legs pair across institutions, savings transfer stays real', () => {
    const h = seedHousehold();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'payment thank you' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'chase credit crd' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    const sc = suggestMapping(parseCsv(CHASE));
    commitImport(h.db, 'Chase', CHASE, { columnMap: sc.columnMap, dateFormat: sc.dateFormat, signRule: sc.signRule, skipRows: 0 });
    const sw = suggestMapping(parseCsv(WF));
    expect(sw.columnMap).toMatchObject({ hasHeader: false, date: 0, amount: 1, description: 4 });
    const r = commitImport(h.db, 'Wells Fargo', WF, { columnMap: sw.columnMap, dateFormat: sw.dateFormat, signRule: sw.signRule, skipRows: 0 });
    expect(r.transferPairs).toBe(1);
    const kinds = h.db.prepare("SELECT descriptor_raw d, kind, transfer_group g FROM transactions WHERE descriptor_raw LIKE '%CHASE CREDIT%' OR descriptor_raw LIKE 'PAYMENT THANK%' OR descriptor_raw LIKE '%WAY2SAVE%'").all() as any[];
    expect(kinds.filter((k) => k.kind === 'internal_transfer')).toHaveLength(2);
    expect(kinds.find((k) => k.d.includes('WAY2SAVE'))!.kind).toBe('spending');
    expect(coverage(h.db, '2026-10-05')[0].stale).toBe(false);
  });

  it('card-payment legs pair in either import order, and an unpaired leg is flagged only once the other side has caught up', () => {
    const h = seedHousehold();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'payment thank you' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'chase credit crd' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    const sw = suggestMapping(parseCsv(WF)), sc = suggestMapping(parseCsv(CHASE));
    const r1 = commitImport(h.db, 'Wells Fargo', WF, { columnMap: sw.columnMap, dateFormat: sw.dateFormat, signRule: sw.signRule, skipRows: 0 }); // WF leg first
    expect(r1.transferPairs).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE kind='internal_transfer'").get()).toEqual({ c: 1 }); // classified by descriptor even before its partner arrives
    const r2 = commitImport(h.db, 'Chase', CHASE, { columnMap: sc.columnMap, dateFormat: sc.dateFormat, signRule: sc.signRule, skipRows: 0 });
    expect(r2.transferPairs).toBe(1);
    expect(h.db.prepare("SELECT COUNT(DISTINCT transfer_group) c FROM transactions WHERE transfer_group IS NOT NULL").get()).toEqual({ c: 1 });
  });

  it('a refund matching a purchase is not paired without descriptor evidence', () => {
    const h = seedHousehold();
    createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-10-01', amountCents: -2500, descriptor: 'PURCHASE AUTHORIZED ON 09/30 ACME HARDWARE' });
    createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: 2500, kind: 'income', descriptor: 'ACME HARDWARE REFUND' });
    expect(pairTransfers(h.db).paired).toBe(0);
  });
});

describe('importing a file again with an account named', () => {
  it('moves rows an earlier import filed under the first account, and never duplicates them', async () => {
    const { seedHousehold } = await import('./helpers.js');
    const { commitImport, previewImport } = await import('../src/ingest/import.js');
    const h = seedHousehold();
    h.db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Wells Fargo Home','Wells Fargo','bank')").run();
    const accts = h.db.prepare("SELECT id FROM accounts WHERE institution='Wells Fargo' ORDER BY id").all() as { id: number }[];
    const csv = '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n"09/23/2026","ROCKET MORTGAGE  LOAN       261003 4288057         BRYS *SEPULVEDA","-25.00","","Posted"\n"09/24/2026","VENMO            PAYMENT    260924 1053527923194   MIRACLE SEPULVEDA","-5.00","","Posted"\n';
    const spec = { columnMap: { hasHeader: true, date: 'DATE', amount: 'AMOUNT', description: 'DESCRIPTION' }, dateFormat: 'M/d/yyyy', signRule: 'as_is' as const, skipRows: 0 };
    const first = commitImport(h.db, 'Wells Fargo', csv, spec); // the old way: no account named, so the first one
    expect(first.imported).toBe(2);
    const second = accts[1].id;
    const p = previewImport(h.db, 'Wells Fargo', csv, spec, { accountId: second });
    expect(p).toMatchObject({ new: 0, alreadyImported: 2, movedToThisAccount: 2 });
    const r = commitImport(h.db, 'Wells Fargo', csv, spec, { accountId: second });
    expect(r).toMatchObject({ imported: 0, movedToThisAccount: 2 });
    expect(h.db.prepare('SELECT COUNT(*) c, MIN(account_id) a, MAX(account_id) b FROM transactions WHERE descriptor_raw LIKE ? OR descriptor_raw LIKE ?').get('ROCKET%', 'VENMO%')).toEqual({ c: 2, a: second, b: second });
    expect(commitImport(h.db, 'Wells Fargo', csv, spec, { accountId: second }).imported).toBe(0); // and now it is an ordinary re-import
  });
});

describe('quoted CSV headers (Wells Fargo checking exports)', () => {
  const csv = '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n"09/23/2026","ROCKET MORTGAGE  LOAN       261003 4288057         BRYS *SEPULVEDA","-25.00","","Posted"\n"09/24/2026","VENMO            PAYMENT    260924 1053527923194   MIRACLE SEPULVEDA","-5.00","","Posted"\n';
  it('a mapping whose column names kept their quote marks (as the old wizard saved them) still finds the columns', async () => {
    const { seedHousehold } = await import('./helpers.js');
    const { previewImport, commitImport } = await import('../src/ingest/import.js');
    const h = seedHousehold();
    const bad = { columnMap: { hasHeader: true, date: '"DATE"', amount: '"AMOUNT"', description: '"DESCRIPTION"' }, dateFormat: 'M/d/yyyy', signRule: 'as_is' as const, skipRows: 0 };
    const p = previewImport(h.db, 'Wells Fargo', csv, bad);
    expect(p.errors).toEqual([]); expect(p.total).toBe(2);
    // and the saved profile keeps working without a mapping being sent again
    expect(previewImport(h.db, 'Wells Fargo', csv).errors).toEqual([]);
    expect(commitImport(h.db, 'Wells Fargo', csv).imported).toBe(2);
  });
  it('an unmapped layout reports its columns parsed (no quote marks) so the wizard can offer them', async () => {
    const { seedHousehold } = await import('./helpers.js');
    const { previewImport } = await import('../src/ingest/import.js');
    const p = previewImport(seedHousehold().db, 'Wells Fargo', csv);
    expect(p.profileId).toBeNull();
    expect(p.columns).toEqual(['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS']);
  });
});
