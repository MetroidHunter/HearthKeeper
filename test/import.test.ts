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

  it('a refund matching a purchase is not paired without descriptor evidence', () => {
    const h = seedHousehold();
    createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-10-01', amountCents: -2500, descriptor: 'PURCHASE AUTHORIZED ON 09/30 ACME HARDWARE' });
    createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-02', amountCents: 2500, kind: 'income', descriptor: 'ACME HARDWARE REFUND' });
    expect(pairTransfers(h.db).paired).toBe(0);
  });
});
