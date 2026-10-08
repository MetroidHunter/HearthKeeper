import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, classify, setSplits } from '../src/core/transactions.js';
import { processGreenlightMessage } from '../src/greenlight/engine.js';
import { ensureChildRules, retireGreenlight } from '../src/greenlight/retire.js';
import { runNoteMatcher } from '../src/notes/matcher.js';
import { addRule } from '../src/core/rules.js';
import { checkInvariants } from '../src/core/balance.js';

const S = ' on October 3, 2026 at 09:15PM';
let n = 100;
const msg = (h: ReturnType<typeof seedHousehold>, m: string, at = S) => processGreenlightMessage(h.db, ++n, m + at, '2026-10-04T00:00:00Z');
const bank = (h: ReturnType<typeof seedHousehold>, date: string, cents: number, desc = 'GREENLIGHT APP 261005 GREENLIGHT BRYS SEPULVEDA') => { const id = createTransaction(h.db, { accountId: h.wf, occurredOn: date, amountCents: cents, descriptor: desc }); classify(h.db, id); return id; };
const row = (h: ReturnType<typeof seedHousehold>, id: number) => h.db.prepare('SELECT kind, note, note_state ns, review_state rs, decided_rule_id r FROM transactions WHERE id=?').get(id) as any;
const cat = (h: ReturnType<typeof seedHousehold>, id: number) => (h.db.prepare('SELECT c.name n FROM transaction_splits s JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=?').get(id) as any)?.n ?? null;

describe('Greenlight is a payment with a note, not a subsystem', () => {
  it('only "allowance transferred to <child>" is used (as a note); everything the cards do is ignored and creates nothing', () => {
    const h = seedHousehold();
    expect(msg(h, '$100.00 allowance transferred to Marion')).toMatchObject({ outcome: 'note' });
    for (const m of ['Miracle spent $9.26 at TST* THE LUMBERYARD BA SEATTLE WA', "Miracle's final purchase amount of $25.78 at El Rinconsito Seattle has posted.", 'Marion withdrew $23.00 from Fairway Food Mart',
      'Marion requests $50.00 to buy groceries', "Marion's $33.79 purchase at WAL-MART was declined.", '↔️ Miracle moved $38.00 from Spend Anywhere to your Wallet. Tap to view details.',
      "Miracle is scheduled to receive $50 allowance tomorrow morning. We'll send it.", 'Miracle received a $0.07 Greenlight Savings Reward!'])
      expect(msg(h, m)).toMatchObject({ outcome: 'noise' });
    expect(msg(h, 'Something brand new happened')).toMatchObject({ outcome: 'unrecognized' }); // still visible on Ingest health
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
    expect(h.db.prepare('SELECT source, amount_cents a, occurred_on d, note, counterparty FROM external_notes').all()).toEqual([{ source: 'greenlight', a: 10000, d: '2026-10-03', note: 'Marion', counterparty: 'Marion' }]);
  });

  it('is idempotent per message, and a note waits for a payment that has not arrived yet', () => {
    const h = seedHousehold();
    const id = ++n; const text = '$100.00 allowance transferred to Marion' + S;
    expect(processGreenlightMessage(h.db, id, text, '2026-10-04T00:00:00Z').outcome).toBe('note');
    expect(processGreenlightMessage(h.db, id, text, '2026-10-04T00:00:00Z').outcome).toBe('duplicate');
    expect(h.db.prepare('SELECT COUNT(*) c FROM external_notes').get()).toEqual({ c: 1 });
    expect(h.db.prepare('SELECT matched_txn_id m FROM external_notes').get()).toEqual({ m: null }); // nothing to attach it to yet
    const t = bank(h, '2026-10-05', -10000); // the bank payment arrives two days later
    runNoteMatcher(h.db);
    expect(row(h, t)).toMatchObject({ note: 'Marion', ns: 'auto_matched' });
  });

  it('funding is an ordinary payment: it lands in the child\'s category through a rule on the note, by amount, whichever arrives first', () => {
    const h = seedHousehold(); ensureChildRules(h.db);
    expect(h.db.prepare("SELECT notes, mode, priority FROM rules WHERE notes LIKE 'greenlight:%' ORDER BY notes").all()).toEqual([{ notes: 'greenlight: Marion', mode: 'suggest', priority: 60 }, { notes: 'greenlight: Miracle', mode: 'suggest', priority: 60 }]);
    h.db.prepare("UPDATE rules SET mode='auto'").run(); // the household's choice once they trust it
    const first = bank(h, '2026-10-05', -10000), second = bank(h, '2026-10-05', -5000);
    expect(row(h, first).kind).toBe('spending'); // not hidden as a transfer any more
    msg(h, '$50.00 allowance transferred to Miracle'); msg(h, '$100.00 allowance transferred to Marion');
    expect(cat(h, first)).toBe('Family Support'); expect(cat(h, second)).toBe('Miracle Spending');
    expect(row(h, first)).toMatchObject({ note: 'Marion', rs: 'auto_categorized' });
    // notes first, payment second
    msg(h, '$100.00 allowance transferred to Marion', ' on October 9, 2026 at 09:15PM');
    const later = bank(h, '2026-10-10', -10000); runNoteMatcher(h.db);
    expect(cat(h, later)).toBe('Family Support');
    expect(checkInvariants(h.db)).toEqual([]);
  });

  it('in suggest mode the payment waits for you with the child\'s category offered as the rule\'s answer', () => {
    const h = seedHousehold(); ensureChildRules(h.db);
    const t = bank(h, '2026-10-05', -10000); msg(h, '$100.00 allowance transferred to Marion');
    expect(row(h, t)).toMatchObject({ rs: 'needs_category', note: 'Marion' }); expect(row(h, t).r).not.toBeNull();
  });

  it('the plan fee and rule-settled payments do not wait for a note; an amount rule works with no Greenlight message at all', () => {
    const h = seedHousehold();
    addRule(h.db, { priority: 40, match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }, { field: 'amount_cents', op: 'eq', value: -662 }] }, action: { type: 'categorize', category: 'Fees and Taxes' }, mode: 'suggest' });
    addRule(h.db, { priority: 50, match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }, { field: 'amount_abs', op: 'eq', value: 10000 }] }, action: { type: 'categorize', category: 'Family Support' }, mode: 'auto' });
    const fee = bank(h, '2026-10-05', -662), hundred = bank(h, '2026-10-05', -10000), other = bank(h, '2026-10-05', -7700);
    expect(row(h, fee).ns).toBe('not_needed'); expect(row(h, hundred).ns).toBe('not_needed'); expect(cat(h, hundred)).toBe('Family Support');
    runNoteMatcher(h.db);
    expect(row(h, other).ns).toBe('awaiting_note'); // nothing says which child $77 was for: it needs a note
  });

  it('a payment and note of different amounts or too far apart never match', () => {
    const h = seedHousehold(); msg(h, '$100.00 allowance transferred to Marion');
    const wrongAmount = bank(h, '2026-10-05', -9000), tooLate = bank(h, '2026-10-20', -10000);
    runNoteMatcher(h.db);
    expect(row(h, wrongAmount).ns).toBe('awaiting_note'); expect(row(h, tooLate).ns).toBe('awaiting_note');
  });
});

describe('one-time move away from the old Greenlight tracking', () => {
  it('restores hidden funding rows, ignores wallet rows (kept, restorable), turns stored allowance messages into notes, and runs once', () => {
    const h = seedHousehold();
    const old = Number(h.db.prepare("INSERT INTO rules(priority,match_json,action_json,mode,origin,notes) VALUES (50, ?, ?, 'auto','user','my own greenlight transfer rule')").run(
      JSON.stringify({ all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }] }), JSON.stringify({ type: 'internal_transfer', reason: 'greenlight_funding' })).lastInsertRowid);
    const f = bank(h, '2026-09-08', -10000); expect(row(h, f).kind).toBe('internal_transfer'); expect(row(h, f).r).toBe(old);
    // what the old engine made on the wallet
    const allow = createTransaction(h.db, { accountId: h.wallet, kind: 'greenlight_allowance', occurredOn: '2026-09-08', amountCents: -10000, descriptor: 'GREENLIGHT ALLOWANCE Marion' });
    setSplits(h.db, allow, [{ categoryId: h.cats['Family Support'], amountCents: -10000, origin: 'rule' }], 'rule');
    const spend = createTransaction(h.db, { accountId: h.wallet, kind: 'ignored', occurredOn: '2026-09-09', amountCents: -707, descriptor: 'WAL-MART', ignoredReason: 'greenlight_spend' });
    // a stored device message the old engine had turned into that allowance transaction
    const ev = Number(h.db.prepare("INSERT INTO raw_events(source, channel, received_at, payload, dedupe_key) VALUES ('greenlight_msg','device','2026-09-08T20:00:00Z', '$100.00 allowance transferred to Marion on September 8, 2026 at 01:00PM', 'k1')").run().lastInsertRowid);
    h.db.prepare("INSERT INTO greenlight_processed(raw_event_id, outcome, txn_id) VALUES (?, 'allowance', ?)").run(ev, allow);
    h.db.prepare("INSERT INTO greenlight_requests(profile_id, amount_cents, requested_at) VALUES (?, 5000, '2026-09-10')").run(h.marion);

    const r = retireGreenlight(h.db);
    expect(r).toMatchObject({ rules: 2, fundingRestored: 1, walletRowsIgnored: 1, messagesReprocessed: 1 });
    expect(h.db.prepare("SELECT COUNT(*) c FROM rules WHERE id=?").get(old)).toEqual({ c: 0 }); // whatever its name, a rule that hid Greenlight payments as transfers is gone
    expect(row(h, f)).toMatchObject({ kind: 'spending', note: 'Marion', ns: 'auto_matched' }); // back as a payment, and the stored message named the child
    expect(row(h, f).rs).toBe('needs_category'); expect(row(h, f).r).not.toBeNull(); // the Marion rule is offering Family Support
    expect(row(h, allow).kind).toBe('ignored'); expect(cat(h, allow)).toBeNull(); expect(row(h, spend).kind).toBe('ignored');
    expect(h.db.prepare("SELECT status FROM greenlight_requests").get()).toEqual({ status: 'declined' });
    expect(checkInvariants(h.db)).toEqual([]);
    expect(retireGreenlight(h.db)).toMatchObject({ skipped: true }); // once
  });
});
