import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { commitImport, markStale } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { createTransaction, setSplits, classify } from '../src/core/transactions.js';
import { addRule } from '../src/core/rules.js';
import { categoryBalance } from '../src/core/balance.js';

const HDR = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';
const spec = (csv: string) => { const m = suggestMapping(parseCsv(csv)); return { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }; };
const prov = (h: any, date: string, cents: number, desc: string) => createTransaction(h.db, { accountId: h.chase, occurredOn: date, amountCents: cents, descriptor: desc, status: 'provisional', authorizedAt: `${date}T18:00:00Z` });

describe('provisional -> posted reconciliation (review findings)', () => {
  it('a posted row arriving after the stale threshold still supersedes its alert (no double count)', () => {
    const h = seedHousehold();
    const p = prov(h, '2026-10-01', -2500, 'STARBUCKS'); classify(h.db, p);
    setSplits(h.db, p, [{ categoryId: h.cats['Eating Out'], amountCents: -2500 }], 'user');
    expect(markStale(h.db, '2026-10-10')).toBe(1);
    const csv = HDR + '10/03/2026,10/04/2026,STARBUCKS #12 SEATTLE WA,Food,Sale,-25.00,\n';
    const r = commitImport(h.db, 'Chase', csv, spec(csv));
    expect(r.supersededProvisionals).toBe(1);
    expect(categoryBalance(h.db, h.cats['Eating Out'], '2026-12-31').splits).toBe(-2500); // not -5000
  });

  it('a tolerance match never steals the provisional an exact row later in the file should get', () => {
    const h = seedHousehold();
    const p = prov(h, '2026-10-02', -1000, 'JOES RESTAURANT');
    const csv = HDR + '10/03/2026,10/04/2026,JOES RESTAURANT,Food,Sale,-12.00,\n10/03/2026,10/04/2026,JOES RESTAURANT,Food,Sale,-10.00,\n';
    const r = commitImport(h.db, 'Chase', csv, spec(csv));
    expect(r.supersededProvisionals).toBe(1);
    const sup = h.db.prepare('SELECT t.amount_cents a FROM transactions t WHERE t.id=(SELECT superseded_by FROM transactions WHERE id=?)').get(p) as any;
    expect(sup.a).toBe(-1000); // the exact row took it; the -12.00 stays a separate new row
    expect((h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE status='posted'").get() as any).c).toBe(2);
  });

  it('a paired transfer alert keeps its kind and pairing when the posted row supersedes it', () => {
    const h = seedHousehold();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'payment thank you' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'chase credit crd' }] }, action: { type: 'internal_transfer', reason: 'card_payment' }, mode: 'auto' });
    const wf = 'x,x,x,x\n';
    void wf;
    const p = prov(h, '2026-10-03', 50000, 'PAYMENT THANK YOU - WEB'); classify(h.db, p);
    const wfLeg = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-10-03', amountCents: -50000, descriptor: 'CHASE CREDIT CRD AUTOPAY 261003' }); classify(h.db, wfLeg);
    h.db.prepare('UPDATE transactions SET transfer_group=? WHERE id IN (?,?)').run(p, p, wfLeg); // as pairTransfers would have linked them
    const csv = HDR + '10/03/2026,10/05/2026,PAYMENT THANK YOU - WEB,,Payment,500.00,\n';
    commitImport(h.db, 'Chase', csv, spec(csv));
    const posted = h.db.prepare("SELECT kind, transfer_group g FROM transactions WHERE status='posted' AND account_id=?").get(h.chase) as any;
    expect(posted).toEqual({ kind: 'internal_transfer', g: p });
    expect((h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE kind='income'").get() as any).c).toBe(0); // no phantom +$500 income
  });

  it('a note matched to the alert follows the posted row', () => {
    const h = seedHousehold();
    const p = prov(h, '2026-10-02', -2399, 'AMZN Mktp US*ABC');
    const n = Number(h.db.prepare("INSERT INTO external_notes(source, occurred_on, amount_cents, note, matched_txn_id) VALUES ('amazon','2026-10-02',-2399,'bags',?)").run(p).lastInsertRowid);
    h.db.prepare("UPDATE transactions SET note='bags', note_state='auto_matched' WHERE id=?").run(p);
    const csv = HDR + '10/02/2026,10/04/2026,AMZN Mktp US*ABC,Shopping,Sale,-23.99,\n';
    commitImport(h.db, 'Chase', csv, spec(csv));
    const postedId = (h.db.prepare("SELECT id FROM transactions WHERE status='posted'").get() as any).id;
    expect((h.db.prepare('SELECT matched_txn_id m FROM external_notes WHERE id=?').get(n) as any).m).toBe(postedId);
    expect((h.db.prepare('SELECT note FROM transactions WHERE id=?').get(postedId) as any).note).toBe('bags');
  });
});

describe('de-dup scope (review finding)', () => {
  it('naming the account keeps an identical fee on a second account; without it the institution scope still de-dups re-imports', () => {
    const h = seedHousehold();
    const second = Number(h.db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Wells Fargo Savings','Wells Fargo','bank')").run().lastInsertRowid);
    const csv = '10/01/2026,-25.00,x,,MONTHLY SERVICE FEE\n';
    const sp = spec(csv);
    expect(commitImport(h.db, 'Wells Fargo', csv, sp, { accountId: h.wf }).imported).toBe(1);
    expect(commitImport(h.db, 'Wells Fargo', csv, sp, { accountId: second }).imported).toBe(1); // a different account's identical fee is real
    expect(commitImport(h.db, 'Wells Fargo', csv, sp, { accountId: h.wf }).imported).toBe(0); // re-importing the same account is a no-op
    expect(commitImport(h.db, 'Wells Fargo', csv, sp).imported).toBe(1); // no account named: institution scope, as before (D35), is its own scope
  });
});
