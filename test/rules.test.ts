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
