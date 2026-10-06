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

  it('withdrawals follow the profile policy and never silently double-charge', () => {
    const h = seedHousehold();
    const r = send(h, 'Marion withdrew $23.00 from Fairway Food Mart Greensboro NC.');
    expect(r.outcome).toBe('withdraw_flagged'); // default policy: ask
    expect(bal(h, 'Family Support').splits).toBe(0);
    const t = h.db.prepare("SELECT flagged, flag_reason r FROM transactions WHERE greenlight_ref LIKE 'withdraw:%'").get() as any;
    expect(t.flagged).toBe(1); expect(t.r).toContain('Fairway');
    h.db.prepare("UPDATE greenlight_profiles SET withdraw_policy='ignore' WHERE display_name='Marion'").run();
    expect(send(h, 'Marion withdrew $5.00 from Some Store.').outcome).toBe('withdraw_ignored');
    h.db.prepare("UPDATE greenlight_profiles SET withdraw_policy='debit_category' WHERE display_name='Miracle'").run();
    expect(send(h, 'Miracle withdrew $20.00 at AN ATM').outcome).toBe('withdraw_debited');
    expect(bal(h, 'Miracle Spending').splits).toBe(-2000);
  });

  it('request messages create a pending request and no charge', () => {
    const h = seedHousehold();
    const r = send(h, 'Marion requests $50.00 to buy groceries');
    expect(r.outcome).toBe('request');
    expect(h.db.prepare("SELECT COUNT(*) c FROM greenlight_requests WHERE status='pending'").get()).toEqual({ c: 1 });
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { captureEvent, replay, clearParsers } from '../src/ingest/events.js';
import { registerGreenlightParser } from '../src/greenlight/parser.js';
const corpusUrl = new URL('../private/export/ifttt_messages.jsonl', import.meta.url);
describe.skipIf(!existsSync(corpusUrl))('real IFTTT corpus through capture -> replay -> engine (private)', () => {
  it('replays cleanly, attributes correctly, and a second replay changes nothing', () => {
    clearParsers(); registerGreenlightParser();
    const h = seedHousehold();
    const msgs = readFileSync(corpusUrl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string);
    for (const m of msgs) captureEvent(h.db, { source: 'greenlight_msg', channel: 'device', payload: m });
    const first = replay(h.db);
    expect(first.byStatus.error ?? 0).toBe(0);
    expect(first.byStatus.unrecognized ?? 0).toBe(0);
    expect(attributionViolations(h.db)).toEqual([]);
    expect(checkInvariants(h.db)).toEqual([]);
    // no allowance ever lands on the wrong profile's category
    const marion = h.db.prepare("SELECT COUNT(*) c FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.descriptor_raw LIKE 'GREENLIGHT ALLOWANCE MARION' AND s.category_id != ?").get(h.cats['Family Support']) as any;
    expect(marion.c).toBe(0);
    const snap = () => JSON.stringify(h.db.prepare('SELECT id, kind, amount_cents, status, occurred_on FROM transactions ORDER BY id').all());
    const before = snap();
    replay(h.db, { includeOk: true });
    expect(snap()).toBe(before);
    expect((h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE kind='greenlight_allowance'").get() as any).c).toBeGreaterThan(10);
  });

  it('final amount picks the closest-amount candidate, and refuses to guess between token-only matches', () => {
    const h = seedHousehold();
    send(h, '$100.00 allowance transferred to Miracle', 'September 27, 2026');
    send(h, 'Miracle spent $10.00 at Blue Bottle Coffee Seattle', 'September 28, 2026');
    send(h, 'Miracle spent $30.00 at Blue Bottle Coffee Seattle', 'September 28, 2026');
    const r = send(h, "Miracle's final purchase amount of $29.50 at Blue Bottle Coffee Seattle has posted.", 'September 30, 2026');
    expect(r.outcome).toBe('spend_updated');
    const amts = (h.db.prepare("SELECT SUM(CASE WHEN s.amount_cents>0 THEN s.amount_cents END) a FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.descriptor_raw LIKE '%Blue Bottle%' GROUP BY t.id ORDER BY a").all() as any[]).map((x) => x.a);
    expect(amts).toEqual([1000, 2950]);
    // token-only ("Seattle Cafe" vs two different "... Seattle ..." rows) must not be attached to either
    send(h, 'Miracle spent $5.00 at Pike Seattle', 'October 1, 2026');
    send(h, 'Miracle spent $6.00 at Ballard Seattle', 'October 1, 2026');
    const r2 = send(h, "Miracle's final purchase amount of $5.50 at Fremont Seattle has posted.", 'October 2, 2026');
    expect((r2 as any).outcome).not.toBe('spend_updated');
  });
  it('unrecognized messages are not terminal: they can be reprocessed', () => {
    const h = seedHousehold();
    processGreenlightMessage(h.db, 9001, 'totally unparseable gibberish', '2026-10-04T00:00:00Z');
    expect(h.db.prepare('SELECT COUNT(*) c FROM greenlight_processed WHERE raw_event_id=9001').get()).toEqual({ c: 0 });
  });

  it('answering a Greenlight spend from the inbox moves the money: category gets the spend, the child\'s category gets it back (not a $0 split)', async () => {
    const { answerCategory } = await import('../src/core/answers.js');
    const h = seedHousehold();
    send(h, '$50.00 allowance transferred to Miracle', 'September 27, 2026');
    send(h, 'Miracle spent $21.83 at Mystery Taco Truck', 'September 28, 2026');
    const id = (h.db.prepare("SELECT id FROM transactions WHERE kind='greenlight_reclass'").get() as { id: number }).id;
    expect(bal(h, 'Eating Out').splits).toBe(0);
    answerCategory(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: 0 }]); // exactly what POST /categorize sends for a one-tap answer
    expect(bal(h, 'Eating Out').splits).toBe(-2183);
    expect(bal(h, 'Miracle Spending').splits).toBe(-5000 + 2183); // the allowance charge is partly given back
    expect((h.db.prepare('SELECT review_state FROM transactions WHERE id=?').get(id) as any).review_state).toBe('user_confirmed');
    expect(h.db.prepare('SELECT COUNT(*) c FROM transaction_splits WHERE transaction_id=?').get(id)).toEqual({ c: 2 });
    expect(checkInvariants(h.db)).toEqual([]);
  });
});
