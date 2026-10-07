import { describe, it, expect } from 'vitest';
import { cleanDescriptor } from '../src/core/descriptor.js';
import { decide, type Rule } from '../src/core/rules.js';

const R = (id: number, priority: number, all_of: any[], category: string): Rule => ({ id, enabled: 1, priority, match: { all_of }, action: { type: 'categorize', category }, mode: 'suggest', origin: 'user' });

describe('descriptor cleaning', () => {
  it('strips processor prefix, store number, city/state', () => {
    expect(cleanDescriptor('TST* THE LUMBERYARD BA SEATTLE WA').clean).toBe('THE LUMBERYARD BA');
    const d = cleanDescriptor('SEPHORA #182 SEATTLE WA');
    expect(d.clean).toBe('SEPHORA');
    expect(d.locationHint).toContain('#182');
  });
  it('wells fargo prefix and card suffix', () => {
    const d = cleanDescriptor('PURCHASE AUTHORIZED ON 07/07 TRADER JOE S #123 SEATTLE WA S301189151997605 CARD 4481', { year: 2026 });
    expect(d.authorizedOn).toBe('2026-07-07');
    expect(d.cardLast4).toBe('4481');
    expect(d.clean).toBe('TRADER JOE S');
  });
});

describe('rules', () => {
  it('word match avoids arco/Marco false positive', () => {
    const rules = [R(1, 100, [{ field: 'descriptor', op: 'word', value: 'arco' }], 'Gas')];
    expect(decide(rules, { descriptor: "Marco's Pizza" }).rule).toBeNull();
    expect(decide(rules, { descriptor: 'ARCO #123' }).rule?.id).toBe(1);
  });
  it('amount rules compare cents, not strings', () => {
    const rules = [R(1, 100, [{ field: 'descriptor', op: 'contains', value: 'venmo' }, { field: 'amount_cents', op: 'eq', value: -15000 }], 'Laser Hair')];
    expect(decide(rules, { descriptor: 'VENMO PAYMENT', amount_cents: -15000 }).rule?.id).toBe(1);
    expect(decide(rules, { descriptor: 'VENMO PAYMENT', amount_cents: -15001 }).rule).toBeNull();
  });
  it('specificity wins and conflicts are reported, not first-wins', () => {
    const a = R(1, 100, [{ field: 'descriptor', op: 'contains', value: 'target' }], 'Groceries');
    const b = R(2, 100, [{ field: 'descriptor', op: 'contains', value: 'target' }], 'Home');
    const c = R(3, 100, [{ field: 'descriptor', op: 'contains', value: 'target' }, { field: 'amount_cents', op: 'between', value: [-500, 0] }], 'Snacks');
    expect(decide([a, b], { descriptor: 'TARGET' }).conflicts.map((x) => x.id)).toEqual([2]);
    expect(decide([a, b, c], { descriptor: 'TARGET', amount_cents: -300 }).rule?.id).toBe(3);
  });
});

describe('descriptor cleaning: shapes seen in real bank history (names are fake)', () => {
  const c = (raw: string) => cleanDescriptor(raw, { year: 2025 });
  it('decodes HTML entities', () => { expect(c('GERBER COLLISION &amp; GLASS').clean).toBe('GERBER COLLISION & GLASS'); });
  it('collapses Amazon marketplace references into one merchant and keeps the ref', () => {
    for (const raw of ['AMZN Mktp US*1Z8137DV2', 'Amazon.com*MF1J56KS1', 'AMAZON MKTPL*EN4MK4PN3']) expect(c(raw).clean).toBe('AMAZON');
    expect(c('AMZN Mktp US*1Z8137DV2').refCode).toBe('1Z8137DV2');
    expect(c('AMAZON PRIME*AB12CD34E').clean).not.toBe('AMAZON'); // Prime is its own category in the guesser
  });
  it('strips p2p date codes and reference numbers and extracts the owner', () => {
    expect(c('VENMO CASHOUT 250826 1044441294478 BRYS SEPULVEDA')).toMatchObject({ clean: 'VENMO CASHOUT', ownerHint: 'brys' });
    expect(c('VENMO PAYMENT 230730 1028486636483 MIRACLE SEPULVEDA')).toMatchObject({ clean: 'VENMO PAYMENT', ownerHint: 'miracle' });
    expect(c('PAYPAL INST XFER 240426 CRUNCHYROLL BRYS SEPULVEDA')).toMatchObject({ clean: 'PAYPAL INST XFER CRUNCHYROLL', ownerHint: 'brys' });
    expect(c('ZELLE FROM PRETTY PARLOR LLC ON 10/13 REF # USBAJ1RATBJE U.S. BANK SEN').clean).toBe('ZELLE FROM PRETTY PARLOR LLC');
    expect(c('RECURRING TRANSFER TO JOE Q WAY2SAVE SAVINGS REF #OP0SRZNP99 XXXXXX').clean).toBe('RECURRING TRANSFER TO JOE Q WAY2SAVE SAVINGS');
  });
  it('wells fargo debit rows: authorized date, processor ref, card, phone', () => {
    const d = c('PURCHASE AUTHORIZED ON 03/29 SQ *ATULEA Seattle WA S382088862271994 CARD 4481');
    expect(d).toMatchObject({ authorizedOn: '2025-03-29', cardLast4: '4481', clean: 'ATULEA' });
    expect(c('RECURRING PAYMENT AUTHORIZED ON 12/29 GOOGLE *Google Sto 855-836-3987 CA S582364002354301 CARD 4481').clean).toBe('GOOGLE STO');
  });
  it('trailing opaque references are removed; ordinary names are untouched', () => {
    expect(c('GOOGLE *CLOUD ZHK8FF').clean).toBe('CLOUD');
    expect(c('HONG KONG BISTRO').clean).toBe('HONG KONG BISTRO');
    expect(c('SAFEWAY #1551').clean).toBe('SAFEWAY');
  });
});

describe('rule priority over the API', () => {
  it('PATCH validates, and a lower number wins when two rules match', async () => {
    const { addRule } = await import('../src/core/rules.js'); const { seedHousehold } = await import('./helpers.js'); const { buildApp } = await import('../src/server/app.js'); const { classify, createTransaction } = await import('../src/core/transactions.js');
    const h = seedHousehold(); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } }); const H = { 'x-requested-with': 'hearthkeeper' };
    const a = addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'cafe' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto', priority: 100 });
    const b = addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'cafe' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto', priority: 200 });
    const mk = (d: string) => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-01', amountCents: -500, descriptor: d }); classify(h.db, id); return id; };
    const cat = (id: number) => (h.db.prepare('SELECT c.name n FROM transaction_splits s JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=?').get(id) as any)?.n;
    expect(cat(mk('NEW CAFE 1'))).toBe('Eating Out'); // 100 beats 200
    for (const bad of [0, 10000, 1.5, 'x', -3]) expect((await app.inject({ method: 'PATCH', url: `/api/rules/${a}`, headers: H, payload: { priority: bad } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/rules/${b}`, headers: H, payload: { priority: 10 } })).statusCode).toBe(200);
    expect(cat(mk('NEW CAFE 2'))).toBe('Groceries'); // now 10 beats 100
    expect((await app.inject({ url: '/api/rules' })).json().map((r: any) => [r.id, r.priority])).toEqual([[b, 10], [a, 100]]); // listed in priority order
  });
});

describe('Wells Fargo checking descriptors (real exports)', () => {
  const c = (raw: string) => cleanDescriptor(raw, { year: 2026 });
  const cases: [string, string][] = [
    ['MONEY TRANSFER                          AUTHORIZED ON   09/09 CASH APP*JAMEEL WI        Oakland       CA  S586252798384996   CARD 6978', 'CASH APP*JAMEEL WI'],
    ['MONEY TRANSFER                          AUTHORIZED ON   09/16 CASH APP*CHRISTOPH        Oakland       CA  S306259641610654   CARD 0414', 'CASH APP*CHRISTOPH'],
    ['PURCHASE                                AUTHORIZED ON   09/22 ORC*00YP28X REGION        888-988-6722  WA  S586266089684427   CARD 0414', 'ORCA'],
    ['PURCHASE                                AUTHORIZED ON   07/09 ORCA                      888-988-6722  WA  S386190780974092   CARD 0414', 'ORCA'],
    ['PURCHASE                                AUTHORIZED ON   09/29 ACE PARKING 3286          BELLVUE       WA  S306273081194346   CARD 6978', 'ACE PARKING 3286'],
    ['ROCKET MORTGAGE  LOAN       261003 4288057         BRYS *SEPULVEDA', 'ROCKET MORTGAGE LOAN'],
    ['GREENLIGHT       APP        261004 GREENLIGHT      BRYS SEPULVEDA', 'GREENLIGHT APP'],
    ['CHASE CREDIT CRD EPAY       261002 9760590069      BRYS K SEPULVEDA', 'CHASE CREDIT CRD EPAY'],
    ['T-MOBILE         PCS SVC    260920 9677020         BRYS SEPULVEDA', 'T-MOBILE PCS SVC'],
    ['Subscription     Acorns     092126 5970Y9          Brys Sepulveda', 'SUBSCRIPTION ACORNS'],
    ['Sequoia One PEO, PAYROLL           121000240001095 SEPULVEDA BRYS K', 'SEQUOIA ONE PEO, PAYROLL'],
    ['Maison de V LLC  Receivable        996IEOXIR1CBS2A 996IEOXIR1CBS2A Maison de V LLC Bill.com 9/29/26', 'MAISON DE V LLC RECEIVABLE'],
    ['BILL.COM         Receivable        996QCTOID1A90BA 996QCTOID1A90BA Langston Bill.com Inv SBNF6', 'BILL.COM RECEIVABLE'],
    ['Haus of Horn Pro BILL PMT   092326 1010240375843   MIRACLE SEPULVED', 'HAUS OF HORN PRO BILL PMT'],
    ['STATE FARM RO 27 SFPP              19 S 1309172619 MIRACLE THOMAS', 'STATE FARM RO 27 SFPP'],
    ['STATE FARM RO 27 CPC-CLIENT        15 J 1780939870 BRYS SEPULVEDA', 'STATE FARM RO 27 CPC-CLIENT'],
    ['DEPT EDUCATION   STUDENT LN 260708 6S3ETSMA321     BRYS SEPULVEDA', 'DEPT EDUCATION STUDENT LN'],
    ['SQUARESPACE PAYM SQUARESPAC        ST-I9D1O1K6J0L7 MIRACLE SEPULVEDA', 'SQUARESPACE PAYM SQUARESPAC'],
    ['MOBILE DEPOSIT : REF NUMBER :801210363925', 'MOBILE DEPOSIT'],
    ['Cash eWithdrawal in Branch 09/30/2026 11:13 AM 625 5TH AVE S SEATTLE WA 6978', 'CASH EWITHDRAWAL IN BRANCH'],
    // unchanged: the P2P / transfer handling
    ['VENMO            PAYMENT    260914 1053050634846   BRYS SEPULVEDA', 'VENMO PAYMENT'],
    ['PAYPAL           PURCHASE   260928 HULU            BRYS SEPULVEDA', 'PAYPAL PURCHASE HULU'],
    ['ZELLE FROM PREMIER VOCAL ENTERTAINMENT LLC ON 08/28 REF # WFCT22L6S4DQ PAY WEEK ENDING 8.22.26  TOTEM LAKE 8.19.26', 'ZELLE FROM PREMIER VOCAL ENTERTAINMENT LLC'],
    ['ONLINE TRANSFER TO SEPULVEDA B EVERYDAY CHECKING XXXXXXXXX3053 REF #IB0ZH5P6P9 ON 08/22/26', 'ONLINE TRANSFER TO SEPULVEDA B EVERYDAY CHECKING'],
    ['RECURRING TRANSFER TO THOMAS M WAY2SAVE SAVINGS REF #OP037X77KQ XXXXXX8702', 'RECURRING TRANSFER TO THOMAS M WAY2SAVE SAVINGS'],
  ];
  for (const [raw, want] of cases) it(want, () => expect(c(raw).clean).toBe(want));
  it('keeps the authorized-on date and card of a money transfer', () => {
    const d = c('MONEY TRANSFER                          AUTHORIZED ON   09/09 CASH APP*JAMEEL WI        Oakland       CA  S586252798384996   CARD 6978');
    expect(d).toMatchObject({ authorizedOn: '2026-09-09', cardLast4: '6978' });
  });
});

describe('re-cleaning stored descriptors after the cleaner improves', () => {
  it('moves changed rows to the right merchant, keeps your answers, removes empty unreviewed merchants, and runs once', async () => {
    const { seedHousehold } = await import('./helpers.js');
    const { createTransaction, classify, setSplits } = await import('../src/core/transactions.js');
    const { recleanDescriptors } = await import('../src/core/reclean.js');
    const h = seedHousehold();
    const raw = 'MONEY TRANSFER                          AUTHORIZED ON   09/09 CASH APP*JAMEEL WI        Oakland       CA  S586252798384996   CARD 6978';
    const a = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-09-10', amountCents: -12500, descriptor: raw }); classify(h.db, a);
    const b = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-09-11', amountCents: -3000, descriptor: raw }); classify(h.db, b);
    setSplits(h.db, b, [{ categoryId: h.cats['Groceries'], amountCents: -3000 }], 'user');
    // pretend both were stored by the old cleaner
    const old = h.db.prepare("INSERT INTO merchants(name, review_state) VALUES ('MONEY TRANSFER AUTHORIZED','unreviewed')").run().lastInsertRowid;
    h.db.prepare("UPDATE transactions SET descriptor_clean='MONEY TRANSFER AUTHORIZED', merchant_id=? WHERE id IN (?,?)").run(old, a, b);
    h.db.prepare("DELETE FROM settings WHERE key='descriptor_version'").run();
    const r = recleanDescriptors(h.db);
    expect(r.changed).toBe(2);
    const row = (id: number) => h.db.prepare('SELECT t.descriptor_clean c, m.name m FROM transactions t JOIN merchants m ON m.id=t.merchant_id WHERE t.id=?').get(id) as any;
    expect(row(a)).toEqual({ c: 'CASH APP*JAMEEL WI', m: 'CASH APP*JAMEEL WI' });
    expect(row(b).m).toBe('CASH APP*JAMEEL WI');
    expect((h.db.prepare('SELECT category_id c FROM transaction_splits WHERE transaction_id=?').get(b) as any).c).toBe(h.cats['Groceries']); // your answer is untouched
    expect(h.db.prepare("SELECT COUNT(*) c FROM merchants WHERE name='MONEY TRANSFER AUTHORIZED'").get()).toEqual({ c: 0 });
    expect(r.merchantsRemoved).toBeGreaterThanOrEqual(1);
    expect(recleanDescriptors(h.db)).toEqual({ changed: 0, merchantsRemoved: 0 }); // once
  });
});
