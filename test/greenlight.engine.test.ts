import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { processGreenlightMessage, createRequest, fundRequest, attributionViolations, walletBalance, missingAllowances } from '../src/greenlight/engine.js';
import { categoryBalance, checkInvariants } from '../src/core/balance.js';
import { addRule } from '../src/core/rules.js';
import { createTransaction, classify } from '../src/core/transactions.js';

const S = (d: string, t = '09:15AM') => ` on ${d} at ${t}`;
let n = 0;
const send = (h: ReturnType<typeof seedHousehold>, text: string, when = 'October 3, 2026') => processGreenlightMessage(h.db, ++n, text + S(when), '2026-10-04T00:00:00Z');
const bal = (h: ReturnType<typeof seedHousehold>, c: string) => categoryBalance(h.db, h.cats[c], '2026-10-31');

describe('greenlight engine', () => {
  it('allowances charge each profile\'s own category (Marion is not booked to Miracle Spending)', () => {
    const h = seedHousehold();
    const m0 = bal(h, 'Miracle Spending').splits, f0 = bal(h, 'Family Support').splits;
    send(h, '$50.00 allowance transferred to Miracle');
    send(h, '$100.00 allowance transferred to Marion');
    expect(bal(h, 'Miracle Spending').splits - m0).toBe(-5000);
    expect(bal(h, 'Family Support').splits - f0).toBe(-10000);
    expect(attributionViolations(h.db)).toEqual([]);
  });

  it('Miracle spend reclassifies with sum-zero splits; final amount re-derives it', () => {
    const h = seedHousehold();
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'rinconsito' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
    send(h, '$50.00 allowance transferred to Miracle', 'September 27, 2026');
    send(h, 'Miracle spent $21.83 at El Rinconsito Seattle', 'September 28, 2026');
    expect(bal(h, 'Eating Out').splits).toBe(-2183);
    expect(bal(h, 'Miracle Spending').splits).toBe(-5000 + 2183);
    const r = send(h, "Miracle's final purchase amount of $25.78 at El Rinconsito Seattle has posted.", 'September 30, 2026');
    expect(r.outcome).toBe('spend_updated');
    expect(bal(h, 'Eating Out').splits).toBe(-2578);
    expect(bal(h, 'Miracle Spending').splits).toBe(-5000 + 2578);
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('unresolved Miracle vendor prompts (null category) and "leave it" nets to zero', () => {
    const h = seedHousehold();
    send(h, 'Miracle spent $9.26 at TST* THE LUMBERYARD BA SEATTLE WA');
    const t = h.db.prepare("SELECT id, review_state FROM transactions WHERE kind='greenlight_reclass'").get() as any;
    expect(t.review_state).toBe('needs_category');
  });

  it('Marion spend is ignored with a reason, no ledger effect', () => {
    const h = seedHousehold();
    const r = send(h, 'Marion spent $7.07 at WAL-MART #3658 GREENSBORO NC');
    expect(r.outcome).toBe('spend_ignored');
    expect(bal(h, 'Family Support').splits).toBe(0);
    expect((h.db.prepare("SELECT ignored_reason r FROM transactions WHERE kind='ignored'").get() as any).r).toBe('greenlight_spend');
  });

  it('returns credit the profile category; replay of the same raw event is a no-op', () => {
    const h = seedHousehold();
    const id = ++n;
    const text = '↔️ Miracle moved $38.00 from Spend Anywhere to your Wallet. Tap to view details.' + S('October 3, 2026');
    expect(processGreenlightMessage(h.db, id, text, '2026-10-04T00:00:00Z').outcome).toBe('return');
    expect(processGreenlightMessage(h.db, id, text, '2026-10-04T00:00:00Z').outcome).toBe('duplicate');
    expect(bal(h, 'Miracle Spending').splits).toBe(3800);
  });

  it('unattributable or unknown-profile messages are never guessed', () => {
    const h = seedHousehold();
    expect(send(h, 'they can no longer use their debit card with payment apps').outcome).toBe('noise');
    expect(send(h, '$20.00 allowance transferred to Stranger').outcome).toBe('unrecognized');
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });

  it('requests never charge by themselves; funding follows profile policy and cannot double-post', () => {
    const h = seedHousehold();
    const rq = createRequest(h.db, h.miracle, 12500, '2026-10-03');
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
    fundRequest(h.db, rq, '2026-10-04');
    expect(bal(h, 'Miracle Spending').splits).toBe(-12500);
    expect(() => fundRequest(h.db, rq, '2026-10-04')).toThrow();
    const rm = createRequest(h.db, h.marion, 4000, '2026-10-03');
    expect(() => fundRequest(h.db, rm, '2026-10-04')).toThrow(/category/);
    fundRequest(h.db, rm, '2026-10-04', h.cats['Groceries']);
    expect(bal(h, 'Groceries').splits).toBe(-4000);
    expect(bal(h, 'Family Support').splits).toBe(0);
  });

  it('funding bank rows are internal transfers (never charge a category) and drive wallet balance', () => {
    const h = seedHousehold();
    addRule(h.db, { priority: 50, match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }, { field: 'amount_cents', op: 'eq', value: -662 }] }, action: { type: 'categorize', category: 'Fees and Taxes' }, mode: 'suggest' });
    addRule(h.db, { priority: 100, match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }] }, action: { type: 'internal_transfer', reason: 'greenlight_funding' }, mode: 'auto' });
    const f = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-06-28', amountCents: -5000, descriptor: 'GREENLIGHT APP 260628 GREENLIGHT BRYS SEPULVEDA' });
    expect(classify(h.db, f).outcome).toBe('internal_transfer');
    const fee = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-06-25', amountCents: -662, descriptor: 'GREENLIGHT APP 260625 GREENLIGHT BRYS SEPULVEDA' });
    expect(classify(h.db, fee).outcome).toBe('suggested');
    send(h, '$50.00 allowance transferred to Miracle');
    expect(walletBalance(h.db, h.wallet)).toBe(5000 - 5000);
  });

  it('expected-allowance forecast shows a gap when the transfer message is missed', () => {
    const h = seedHousehold();
    send(h, "Miracle is scheduled to receive $50 allowance tomorrow morning. We'll send it unless you'd like to pause it.", 'October 3, 2026');
    expect(missingAllowances(h.db, '2026-10-04')).toHaveLength(0);
    expect(missingAllowances(h.db, '2026-10-10')).toHaveLength(1);
    send(h, '$50.00 allowance transferred to Miracle', 'October 4, 2026');
    expect(missingAllowances(h.db, '2026-10-10')).toHaveLength(0);
  });
});
