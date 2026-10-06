import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { seedHousehold } from './helpers.js';
import { parseAmazonOrders, parseVenmo, parsePayPal, amazonNote } from '../src/receipts/parsers.js';
import { htmlToText } from '../src/receipts/text.js';
import { parseWfNotice, lineDate } from '../src/wf/notice.js';
import { captureEvent, parseEvent, clearParsers } from '../src/ingest/events.js';
import { registerAllParsers } from '../src/ingest/parsers.js';
import { createTransaction } from '../src/core/transactions.js';
import { runNoteMatcher } from '../src/notes/matcher.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { setSplits } from '../src/core/transactions.js';
import { parseChaseEmail } from '../src/chase/parser.js';
import { replay } from '../src/ingest/events.js';

// Fixtures are real emails (HTML parts, tracking attributes and personal details stripped) in test/fixtures/receipts.
interface Fx { headers: Record<string, string>; text: string; html: string }
const fx = (n: string): Fx => JSON.parse(readFileSync(new URL(`./fixtures/receipts/${n}.json`, import.meta.url), 'utf8'));
const body = (n: string) => htmlToText(fx(n).html);
const cap = (h: ReturnType<typeof seedHousehold>, source: string, n: string, extra: Record<string, unknown> = {}) =>
  captureEvent(h.db, { source, channel: 'email', payload: fx(n).text || 'plain part is empty', html: fx(n).html, headers: fx(n).headers, dedupeKey: n + JSON.stringify(extra) } as any);

describe('real-email parsers', () => {
  it('through the real ingest endpoint: the signed POST from the forwarder keeps the html part, and the parser reads it', async () => {
    const { buildApp } = await import('../src/server/app.js'); const { sign } = await import('../src/ingest/events.js'); const { createToken } = await import('../src/ingest/events.js');
    clearParsers(); const h = seedHousehold(); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 's' }, now: () => '2026-10-06' });
    const t = createToken(h.db, 'receiver-mailbox', 'email');
    const body = JSON.stringify({ source: 'venmo_receipt', messageId: 'v1', text: '', html: fx('venmo_paid').html, headers: fx('venmo_paid').headers }); // empty plain part, like real Venmo mail
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await app.inject({ method: 'POST', url: '/ingest/email', headers: { 'content-type': 'application/json', 'x-hk-token': 'receiver-mailbox', 'x-hk-timestamp': ts, 'x-hk-nonce': 'n1', 'x-hk-signature': sign(t.secret, ts, 'n1', body) }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(h.db.prepare("SELECT parse_status s, error FROM raw_events").get()).toEqual({ s: 'ok', error: null });
    expect(h.db.prepare('SELECT amount_cents c, counterparty FROM external_notes').get()).toEqual({ c: -17800, counterparty: 'Casey Lind' });
    // an event stored before html was kept (plain text only, unparsed): resending the same message fills the html in and parses it
    const old = captureEvent(h.db, { source: 'paypal_receipt', channel: 'email', payload: 'You paid $5.00 USD to Sample Shop', headers: fx('paypal_receipt').headers, dedupeKey: 'paypal_receipt:p1' });
    expect(parseEvent(h.db, old.id)).toMatchObject({ status: 'unrecognized' });
    const body2 = JSON.stringify({ source: 'paypal_receipt', messageId: 'p1', text: 'You paid $5.00 USD to Sample Shop', html: fx('paypal_receipt').html, headers: fx('paypal_receipt').headers });
    const ts2 = String(Math.floor(Date.now() / 1000));
    const r2 = await app.inject({ method: 'POST', url: '/ingest/email', headers: { 'content-type': 'application/json', 'x-hk-token': 'receiver-mailbox', 'x-hk-timestamp': ts2, 'x-hk-nonce': 'n2', 'x-hk-signature': sign(t.secret, ts2, 'n2', body2) }, payload: body2 });
    expect(r2.json()).toMatchObject({ id: old.id, duplicate: false });
    expect(h.db.prepare("SELECT parse_status s FROM raw_events WHERE id=?").get(old.id)).toEqual({ s: 'ok' });
  });
  it('htmlToText keeps inline-split amounts together and drops invisible padding', () => {
    expect(htmlToText('<div><span>$</span><span>15</span><span>.</span><span>00</span></div><p>a&nbsp;&zwnj;b&amp;c</p>')).toBe('$15.00\na b&c');
  });
  it('amazon: two orders in one "Ordered 3 items" email, category summary as the note', () => {
    for (const text of [body('amazon_order'), fx('amazon_order').text]) { // html part and the forwarder's plain text
      const os = parseAmazonOrders(text);
      expect(os.map((o) => [o.totalCents, o.orderRef.length])).toEqual([[2810, 19], [5747, 19]]);
    }
    const os = parseAmazonOrders(body('amazon_order'));
    expect(os[0].items).toEqual([{ name: 'Pet Supplies', qty: 1, cents: 0 }, { name: 'Skin Care', qty: 1, cents: 0 }]);
    expect(amazonNote(os[0].items)).toBe('pet supplies,skin care');
    expect(amazonNote(os[1].items)).toBe('pet supplies');
    expect(parseAmazonOrders('Your package was delivered')).toEqual([]);
    expect(parseAmazonOrders('Order # 112-3456789-0123456 shipped')).toEqual([]); // strict: a total is required
  });
  it('venmo: paid and received, amount split across elements, memo, date and id', () => {
    expect(parseVenmo(body('venmo_paid'))).toMatchObject({ counterparty: 'Casey Lind', cents: -17800, date: '2026-09-13', note: '🎉' });
    expect(parseVenmo(body('venmo_received'))).toMatchObject({ counterparty: 'Jordan Reed', cents: 1500, date: '2026-09-12', note: '💸 to Sample Group' });
    expect(parseVenmo(body('venmo_paid'))!.txnId).toMatch(/^\d{10,}$/);
    expect(parseVenmo('Welcome to Venmo')).toBeNull();
    expect(parseVenmo('You paid Sam Lee $15.00')).toBeNull(); // no transaction details block
  });
  it('paypal: receipt (RT000403) and merchant payment with items (RT001736)', () => {
    expect(parsePayPal(body('paypal_receipt'))).toMatchObject({ merchant: 'Sample Shop', cents: -500, date: '2026-07-22', statement: 'PAYPAL *SAMPLESHOP SAMPLESHOP', items: [] });
    expect(parsePayPal(body('hulu_paypal'))).toMatchObject({ merchant: 'Hulu', cents: -1365, date: '2026-09-28', items: [{ name: 'Hulu with Ads', qty: 1, cents: 1365 }] });
    expect(parsePayPal('Your statement is ready')).toBeNull();
  });
  it('wells fargo account update: account, as-of date and lines', () => {
    expect(parseWfNotice(body('wf_purchase'))).toEqual({ last4: '2222', asOf: '2026-10-02', lines: [{ description: expect.stringMatching(/^PURCHASE\s+AUTHORIZED ON\s+09\/29 ACE PARKING/), cents: -1400 }] });
    expect(parseWfNotice(body('wf_greenlight'))).toMatchObject({ last4: '1111', asOf: '2026-09-26', lines: [{ cents: -662 }] });
    expect(parseWfNotice(fx('wf_purchase').text)).toBeNull(); // empty plain part: only the HTML part carries it (the forwarder falls back to html)
    expect(parseWfNotice('Your balance is low')).toBeNull();
    expect(parseWfNotice("Here's the rundown for account ...1111 Deposits PAYROLL ACME $1,234.50 As of 10/02/2026 at 1:00 a.m.")).toMatchObject({ lines: [{ description: 'PAYROLL ACME', cents: 123450 }] });
  });
  it('wells fargo: a hand-forwarded plain-text copy with several withdrawals (as Gmail renders it)', () => {
    const fwd = `---------- Forwarded message ---------
From: Wells Fargo <alerts@notify.wellsfargo.com>
Subject: Your account update is here

[image: Wells Fargo home page] <https://www.wellsfargo.com>
Here's the rundown

for account ...1111
Go to accounts <https://connect.secure.wellsfargo.com/auth/login/ulink>
*Withdrawals*
GREENLIGHT APP 261004 GREENLIGHT ALEX SAMPLE $125.00
CHASE CREDIT CRD EPAY 261002 9760590069 ALEX K SAMPLE $6,896.31
VENMO PAYMENT 261004 1053527923194 JORDAN SAMPLE $25.00
ROCKET MORTGAGE LOAN 261003 $2,000.00
As of 10/06/2026 at 12:42 a.m., Central Time`; // the amount of the last line is invented (the sample was cut off there)
    const n = parseWfNotice(fwd)!;
    expect(n.last4).toBe('1111');
    expect(n.lines.map((l) => [l.description.split(' ')[0], l.cents])).toEqual([['GREENLIGHT', -12500], ['CHASE', -689631], ['VENMO', -2500], ['ROCKET', -200000]]);
    expect(n.lines[0].description).toBe('GREENLIGHT APP 261004 GREENLIGHT ALEX SAMPLE');
  });
  it('line date: the purchase date, with the year rolled back across New Year', () => {
    expect(lineDate('PURCHASE AUTHORIZED ON 09/29 ACE PARKING', '2026-10-02')).toBe('2026-09-29');
    expect(lineDate('PURCHASE AUTHORIZED ON 12/31 X', '2027-01-02')).toBe('2026-12-31');
    expect(lineDate('GREENLIGHT APP 260925', '2026-09-26')).toBe('2026-09-26');
  });

  describe('end to end', () => {
    beforeEach(() => clearParsers());
    it('amazon email becomes one note per order; the same email twice adds nothing; the bank charge picks the note up', () => {
      const h = seedHousehold(); registerAllParsers();
      parseEvent(h.db, cap(h, 'amazon_receipt', 'amazon_order').id);
      parseEvent(h.db, cap(h, 'amazon_receipt', 'amazon_order', { again: 1 }).id);
      expect(h.db.prepare('SELECT COUNT(*) c FROM external_notes').get()).toEqual({ c: 2 });
      expect(h.db.prepare('SELECT COUNT(*) c FROM external_note_items').get()).toEqual({ c: 3 });
      const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-09-24', amountCents: -5747, descriptor: 'AMZN Mktp US*2K4LM9' });
      runNoteMatcher(h.db);
      expect(h.db.prepare('SELECT note FROM transactions WHERE id=?').get(t)).toEqual({ note: 'pet supplies' });
    });
    it('venmo and paypal: forwarded html is parsed, a repeat of the same transaction id is one note, other mail stays unrecognized', () => {
      const h = seedHousehold(); registerAllParsers();
      for (const [s, n] of [['venmo_receipt', 'venmo_paid'], ['paypal_receipt', 'paypal_receipt'], ['paypal_receipt', 'hulu_paypal']] as const) expect(parseEvent(h.db, cap(h, s, n).id)).toEqual({ status: 'ok' });
      parseEvent(h.db, cap(h, 'venmo_receipt', 'venmo_paid', { again: 1 }).id);
      expect(h.db.prepare('SELECT source, amount_cents c, occurred_on d, counterparty FROM external_notes ORDER BY id').all()).toEqual([
        { source: 'venmo', c: -17800, d: '2026-09-13', counterparty: 'Casey Lind' }, { source: 'paypal', c: -500, d: '2026-07-22', counterparty: 'Sample Shop' }, { source: 'paypal', c: -1365, d: '2026-09-28', counterparty: 'Hulu' }]);
      expect(parseEvent(h.db, captureEvent(h.db, { source: 'paypal_receipt', channel: 'email', payload: 'Weekly summary' }).id)).toMatchObject({ status: 'unrecognized' });
    });
    it('wells fargo alerts: need the account last 4; then create provisionals, dedupe, and the bank file supersedes them', () => {
      const h = seedHousehold(); registerAllParsers();
      const ev = cap(h, 'wf_notice', 'wf_purchase');
      expect(parseEvent(h.db, ev.id)).toMatchObject({ status: 'error', error: expect.stringContaining('2222') });
      h.db.prepare("UPDATE accounts SET last4='2222' WHERE id=?").run(h.wf);
      expect(parseEvent(h.db, ev.id)).toEqual({ status: 'ok' });
      expect(h.db.prepare("SELECT status, amount_cents c, occurred_on d, review_state r FROM transactions WHERE account_id=?").all(h.wf)).toEqual([{ status: 'provisional', c: -1400, d: '2026-09-29', r: 'needs_category' }]);
      parseEvent(h.db, cap(h, 'wf_notice', 'wf_purchase', { again: 1 }).id);
      expect(h.db.prepare('SELECT COUNT(*) c FROM transactions WHERE account_id=?').get(h.wf)).toEqual({ c: 1 });
      // a posted row already in the books: the alert adds nothing
      h.db.prepare("UPDATE accounts SET last4='1111' WHERE id=?").run(h.wf);
      createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-09-25', amountCents: -662, descriptor: 'GREENLIGHT APP 260925 GREENLIGHT ALEX SAMPLE' });
      // a hand-forwarded message: the script reports the inner sender in X-HK-Original-From; the outer sender (a person) is not checked as the bank
      const manual = captureEvent(h.db, { source: 'wf_notice', channel: 'email', payload: 'x', html: fx('wf_purchase').html, headers: { From: 'Me <me@gmail.com>', 'X-HK-Original-From': 'Wells Fargo <alerts@notify.wellsfargo.com>' }, dedupeKey: 'manual' } as any);
      h.db.prepare("UPDATE accounts SET last4='2222' WHERE id=?").run(h.wf);
      expect(parseEvent(h.db, manual.id)).toEqual({ status: 'ok' });
      const spoof = captureEvent(h.db, { source: 'wf_notice', channel: 'email', payload: 'x', html: fx('wf_purchase').html, headers: { From: 'Me <me@gmail.com>' }, dedupeKey: 'spoof' } as any);
      expect(parseEvent(h.db, spoof.id)).toMatchObject({ status: 'unrecognized', error: expect.stringContaining('not wellsfargo.com') });
      parseEvent(h.db, cap(h, 'wf_notice', 'wf_greenlight').id);
      expect(h.db.prepare('SELECT COUNT(*) c FROM transactions WHERE account_id=?').get(h.wf)).toEqual({ c: 2 });
    });
    it('a bank CSV that repeats a charge the alert already created supersedes it (keeping the answer); a CSV imported first makes the alert a no-op', () => {
      const h = seedHousehold(); registerAllParsers();
      h.db.prepare("UPDATE accounts SET last4='2222' WHERE id=?").run(h.wf);
      parseEvent(h.db, cap(h, 'wf_notice', 'wf_purchase').id);
      const prov = (h.db.prepare("SELECT id FROM transactions WHERE status='provisional'").get() as any).id;
      setSplits(h.db, prov, [{ categoryId: h.cats['Fees and Taxes'], amountCents: -1400 }]); // answered from the phone before the file arrives
      const csv = '10/02/2026,-14.00,*, ,PURCHASE AUTHORIZED ON 09/29 ACE PARKING 3286 BELLVUE WA S306273081194346 CARD 4444\n';
      const m = suggestMapping(parseCsv(csv)); const sp = { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 };
      expect(commitImport(h.db, 'Wells Fargo', csv, sp, { accountId: h.wf }).imported).toBe(1);
      expect(h.db.prepare("SELECT status, COUNT(*) c FROM transactions GROUP BY status ORDER BY status").all()).toEqual([{ status: 'posted', c: 1 }, { status: 'void', c: 1 }]);
      const posted = (h.db.prepare("SELECT id FROM transactions WHERE status='posted'").get() as any).id;
      expect(h.db.prepare('SELECT category_id c FROM transaction_splits WHERE transaction_id=?').get(posted)).toEqual({ c: h.cats['Fees and Taxes'] });
      // the other order: the alert for an already-imported charge is ignored
      parseEvent(h.db, cap(h, 'wf_notice', 'wf_purchase', { late: 1 }).id);
      expect(h.db.prepare("SELECT COUNT(*) c FROM transactions WHERE status!='void'").get()).toEqual({ c: 1 });
    });
  });
});

describe('account last 4 (wells fargo alert routing)', () => {
  it('PATCH validates, is unique per institution, and can clear', async () => {
    const { buildApp } = await import('../src/server/app.js'); const h = seedHousehold();
    h.db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Wells Fargo 2','Wells Fargo','bank')").run();
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 's' }, now: () => '2026-10-04' }); const patch = (id: number, last4: unknown) => app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers: { 'x-requested-with': 'hearthkeeper' }, payload: { last4 } });
    expect((await patch(h.wf, '1234')).statusCode).toBe(200);
    expect((await patch(h.wf, '12')).statusCode).toBe(400);
    expect((await patch(h.wf + 100, '1234')).statusCode).toBe(404);
    const other = (h.db.prepare("SELECT id FROM accounts WHERE name='Wells Fargo 2'").get() as any).id;
    expect((await patch(other, '1234')).statusCode).toBe(409);
    expect((await patch(h.wf, null)).statusCode).toBe(200);
    expect((await patch(other, '1234')).statusCode).toBe(200);
  });
});

describe('hand-forwarded mail from a household member', () => {
  beforeEach(() => clearParsers());
  const AUTH = 'mx.google.com; dkim=pass header.i=@gmail.com header.s=x; spf=pass smtp.mailfrom=me@gmail.com; dmarc=pass (p=NONE) header.from=gmail.com';
  const CHASE_FWD = `---------- Forwarded message ---------
From: Chase <no.reply.alerts@chase.com>
Date: Tue, Oct 6, 2026, 01:27
Subject: You made a $30.00 transaction with PAYPAL *NY TIMES NYT
To: <me@gmail.com>


This transaction is above the level you set, see more here.

[image: Chase Logo]
Transaction alert
You made a $30.00 transaction
Account Prime Visa (...4585)
Date Oct 6, 2026`;
  const WF_FWD = `---------- Forwarded message ---------
From: Wells Fargo <alerts@notify.wellsfargo.com>
Subject: Your account update is here

Here's the rundown

for account ...1111
*Withdrawals*
ROCKET MORTGAGE LOAN 261003 42880 $2,000.00
As of 10/06/2026 at 12:42 a.m., Central Time`;
  const hand = (h: ReturnType<typeof seedHousehold>, payload: string, from = 'Me <me@gmail.com>', auth = AUTH, key = payload.slice(0, 120)) =>
    captureEvent(h.db, { source: 'email_unknown', channel: 'email', payload, headers: { From: from, 'Authentication-Results': auth }, dedupeKey: key });
  it('chase alert email: amount, merchant and date (no time of day)', () => {
    expect(parseChaseEmail([CHASE_FWD])).toEqual({ amountCents: -3000, vendor: 'PAYPAL *NY TIMES NYT', authorizedAtUtc: null, occurredOn: '2026-10-06' });
    expect(parseChaseEmail(['Transaction alert\nYou made a $30.00 transaction\nDate Oct 6, 2026'], 'You made a $30.00 transaction with PAYPAL *NY TIMES NYT')).toMatchObject({ vendor: 'PAYPAL *NY TIMES NYT' }); // subject header only (filter-forwarded)
    expect(parseChaseEmail(['hello'])).toBeNull();
  });
  it('is taken as the original sender\'s mail only for a household member whose forward is authenticated', () => {
    const h = seedHousehold(); registerAllParsers();
    h.db.prepare("INSERT INTO users(name,email) VALUES ('Me','me@gmail.com')").run();
    h.db.prepare("UPDATE accounts SET last4='1111' WHERE id=?").run(h.wf);
    const wf = hand(h, WF_FWD), ch = hand(h, CHASE_FWD);
    expect(parseEvent(h.db, wf.id)).toEqual({ status: 'ok' });
    expect(parseEvent(h.db, ch.id)).toEqual({ status: 'ok' });
    expect(h.db.prepare("SELECT id, source FROM raw_events ORDER BY id").all()).toEqual([{ id: wf.id, source: 'wf_notice' }, { id: ch.id, source: 'chase_alert' }]);
    expect(h.db.prepare("SELECT amount_cents c, occurred_on d, descriptor_raw x, status s FROM transactions ORDER BY id").all()).toEqual([
      { c: -200000, d: '2026-10-06', x: 'ROCKET MORTGAGE LOAN 261003 42880', s: 'provisional' }, { c: -3000, d: '2026-10-06', x: 'PAYPAL *NY TIMES NYT', s: 'provisional' }]);
    parseEvent(h.db, ch.id); replay(h.db, { includeOk: true });
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 2 }); // replay-safe
    // not a household member / not authenticated as them / forwarded from an unknown sender: stays unknown
    for (const [from, auth, text] of [['Eve <eve@gmail.com>', AUTH.replace(/me@/, 'eve@'), CHASE_FWD], ['Me <me@gmail.com>', 'mx.google.com; spf=pass', CHASE_FWD], ['Me <me@gmail.com>', AUTH, CHASE_FWD.replace('no.reply.alerts@chase.com', 'x@evil.com')]]) {
      const e = hand(h, text, from, auth, from + auth + text.length);
      expect(parseEvent(h.db, e.id)).toBeNull();
      expect(h.db.prepare('SELECT source FROM raw_events WHERE id=?').get(e.id)).toEqual({ source: 'email_unknown' });
    }
  });
});
