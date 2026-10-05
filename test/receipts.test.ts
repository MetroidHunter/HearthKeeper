import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { parseAmazonOrder, parseVenmo, parsePayPal, amazonNote } from '../src/receipts/parsers.js';
import { captureEvent, parseEvent, clearParsers, replay } from '../src/ingest/events.js';
import { registerAllParsers } from '../src/ingest/parsers.js';
import { createTransaction } from '../src/core/transactions.js';
import { runNoteMatcher } from '../src/notes/matcher.js';

// These samples are GUESSES at the common shapes, not captured emails (see docs/STATUS.md): replace with real fixtures after discovery.
const AMAZON = `Hello,
Thank you for your order.
Order #112-3456789-0123456
Placed on October 3, 2026

Bags - Resealable Cellophane (100 Pack)
Quantity: 1
$12.99

Photo Sleeves, Clear (50 count)
Quantity: 2
$8.50

Order Total: $23.99
Arriving Tuesday`;
const VENMO = `You paid Sam Lee $15.00
🍕🍝🍷
Transfer Date and Amount:
Oct 3, 2026 · - $15.00
Payment ID: 1234`;

describe('experimental receipt parsers', () => {
  it('amazon: order ref, total, items and the skills\' lowercase-noun note convention', () => {
    const o = parseAmazonOrder(AMAZON)!;
    expect(o).toMatchObject({ orderRef: '112-3456789-0123456', totalCents: 2399 });
    expect(o.items).toEqual([{ name: 'Bags - Resealable Cellophane (100 Pack)', qty: 1, cents: 1299 }, { name: 'Photo Sleeves, Clear (50 count)', qty: 2, cents: 850 }]);
    expect(amazonNote(o.items)).toBe('bags,photo sleeves');
    expect(parseAmazonOrder('Your package was delivered')).toBeNull();
    expect(parseAmazonOrder('Order #112-3456789-0123456 shipped')).toBeNull(); // strict: a total is required
  });
  it('venmo and paypal shapes', () => {
    expect(parseVenmo(VENMO)).toEqual({ counterparty: 'Sam Lee', cents: -1500, note: '🍕🍝🍷' });
    expect(parseVenmo('Sam Lee paid you $20.00\nrent')).toMatchObject({ cents: 2000, counterparty: 'Sam Lee', note: 'rent' });
    expect(parseVenmo('Welcome to Venmo')).toBeNull();
    expect(parsePayPal('You sent a payment of $12.50 USD to Instant Ink\nThanks')).toEqual({ cents: -1250, merchant: 'Instant Ink' });
    expect(parsePayPal('Your statement is ready')).toBeNull();
  });

  describe('end to end (opt-in)', () => {
    beforeEach(() => clearParsers());
    it('is off by default: events are captured and stay pending, nothing is created', () => {
      const h = seedHousehold(); registerAllParsers({ experimental: false });
      captureEvent(h.db, { source: 'amazon_receipt', channel: 'email', payload: AMAZON });
      expect(replay(h.db).replayed).toBe(0);
      expect(h.db.prepare("SELECT parse_status s FROM raw_events").get()).toEqual({ s: 'pending' });
      expect(h.db.prepare('SELECT COUNT(*) c FROM external_notes').get()).toEqual({ c: 0 });
    });
    it('amazon receipt becomes a note with items, then auto-matches the later bank charge; a duplicate email adds nothing', () => {
      const h = seedHousehold(); registerAllParsers({ experimental: true });
      const e1 = captureEvent(h.db, { source: 'amazon_receipt', channel: 'email', payload: AMAZON, headers: { Date: 'Sat, 03 Oct 2026 10:00:00 -0700' }, dedupeKey: 'm1' });
      parseEvent(h.db, e1.id);
      const e2 = captureEvent(h.db, { source: 'amazon_receipt', channel: 'email', payload: AMAZON, headers: { Date: 'Sat, 03 Oct 2026 10:05:00 -0700' }, dedupeKey: 'm2' });
      parseEvent(h.db, e2.id);
      expect(h.db.prepare('SELECT COUNT(*) c FROM external_notes').get()).toEqual({ c: 1 });
      expect(h.db.prepare('SELECT COUNT(*) c FROM external_note_items').get()).toEqual({ c: 2 });
      const t = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -2399, descriptor: 'AMZN Mktp US*2K4LM9' });
      runNoteMatcher(h.db);
      expect(h.db.prepare('SELECT note, note_state s FROM transactions WHERE id=?').get(t)).toEqual({ note: 'bags,photo sleeves', s: 'auto_matched' });
    });
    it('venmo with a vague emoji note matches but is flagged for a real note; unknown shapes stay unrecognized', () => {
      const h = seedHousehold(); registerAllParsers({ experimental: true });
      const v = captureEvent(h.db, { source: 'venmo_receipt', channel: 'email', payload: 'You paid Sam Lee $15.00\n🍕\nPayment ID: 1', headers: { Date: 'Fri, 02 Oct 2026 12:00:00 -0700' } });
      parseEvent(h.db, v.id);
      const t = createTransaction(h.db, { accountId: h.wf, occurredOn: '2026-10-04', amountCents: -1500, descriptor: 'VENMO PAYMENT 261003 1000000001 BRYS' });
      runNoteMatcher(h.db);
      expect(h.db.prepare('SELECT note_state s, flag_reason f FROM transactions WHERE id=?').get(t)).toMatchObject({ s: 'needs_note' });
      const u = captureEvent(h.db, { source: 'paypal_receipt', channel: 'email', payload: 'Weekly summary' });
      expect(parseEvent(h.db, u.id)).toMatchObject({ status: 'unrecognized' });
    });
  });
});
