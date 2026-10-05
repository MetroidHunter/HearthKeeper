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
