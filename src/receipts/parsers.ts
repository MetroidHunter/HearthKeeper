import { DateTime } from 'luxon';
import type { DB } from '../core/db.js';
import { parseCents } from '../core/money.js';
import { HOME_ZONE } from '../core/time.js';
import { registerParser, type ParseResult, type RawEvent } from '../ingest/events.js';
import { extractText } from '../greenlight/parser.js';
import { runNoteMatcher } from '../notes/matcher.js';

/**
 * EXPERIMENTAL receipt parsers (design §10.1, §19.2). The real emails have not been captured yet, so these are written from the common shapes of
 * Amazon, Venmo and PayPal notifications and are OFF by default (HK_EXPERIMENTAL_PARSERS=1). Rules for every parser here:
 *  - strict or unrecognized: a message that does not match every required field is `unrecognized`, never half-parsed;
 *  - they only create `external_notes` (a pool the matcher draws from), never transactions;
 *  - once the discovery track has produced real samples, replace the regexes and keep the tests.
 */
export const RECEIPT_PARSER_VERSION = 'receipts-exp-1';

interface Headers { [k: string]: string }
const headersOf = (ev: RawEvent): Headers => { try { return JSON.parse(ev.headers_json ?? '{}'); } catch { return {}; } };
function receivedDate(ev: RawEvent, h: Headers): string {
  const d = h.Date ? DateTime.fromRFC2822(h.Date, { setZone: true }) : DateTime.invalid('none');
  return (d.isValid ? d : DateTime.fromISO(ev.received_at)).setZone(HOME_ZONE).toISODate()!;
}
/** Which person's account does a forwarded receipt belong to? Uses the original-recipient header against `users.email` (VERIFY on a real forwarded sample). */
function ownerAccount(db: DB, h: Headers, institution: string): number | null {
  const to = `${h['Delivered-To'] ?? ''} ${h['X-Forwarded-For'] ?? ''} ${h['X-Forwarded-To'] ?? ''} ${h.To ?? ''}`.toLowerCase();
  for (const u of db.prepare('SELECT name, email FROM users WHERE email IS NOT NULL').all() as { name: string; email: string }[]) {
    if (to.includes(u.email.toLowerCase())) { const a = db.prepare('SELECT id FROM accounts WHERE institution=? AND name LIKE ?').get(institution, `%${u.name}%`) as { id: number } | undefined; if (a) return a.id; }
  }
  return null;
}
const money = (s: string) => parseCents(s.replace(/,/g, ''));
const done = (db: DB, ev: RawEvent, parser: string, noteId: number): ParseResult => { db.prepare('INSERT OR IGNORE INTO event_results(raw_event_id, parser, outcome, txn_id) VALUES (?,?,?,NULL)').run(ev.id, parser, `note:${noteId}`); return { status: 'ok' }; };
const seen = (db: DB, ev: RawEvent, parser: string) => !!db.prepare('SELECT 1 FROM event_results WHERE raw_event_id=? AND parser=?').get(ev.id, parser);

/* ---------- Amazon order confirmation ---------- */
export interface AmazonOrder { orderRef: string; totalCents: number; items: { name: string; qty: number; cents: number }[] }
export function parseAmazonOrder(text: string): AmazonOrder | null {
  const ref = /Order\s*#\s*(\d{3}-\d{7}-\d{7})/i.exec(text);
  const tot = /(?:Order Total|Total for this order|Grand Total)\s*:?\s*\$([\d,]+\.\d{2})/i.exec(text);
  if (!ref || !tot) return null;
  const items: AmazonOrder['items'] = [];
  // item blocks: a name line, then "Quantity: N" and (optionally) a price line
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((l, i) => {
    const q = /^Quantity:\s*(\d+)/i.exec(l);
    if (!q) return;
    const name = [...lines.slice(0, i)].reverse().find((x) => x && !/^(Quantity|Order|Arriving|Delivery|Ship|Total|\$|View|Your)/i.test(x));
    const price = lines.slice(i + 1, i + 4).map((x) => /^\$?([\d,]+\.\d{2})$/.exec(x)?.[1]).find(Boolean);
    if (name) items.push({ name: name.replace(/\s+/g, ' ').slice(0, 140), qty: Number(q[1]), cents: price ? money(price) : 0 });
  });
  return { orderRef: ref[1], totalCents: money(tot[1]), items };
}
/** The skills' convention: a short, lowercase, comma-separated list of nouns ("bags,photo sleeves,cardstock"). */
export function amazonNote(items: { name: string }[]): string {
  return items.map((i) => i.name.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').split(/[,;|:–-]/)[0].replace(/\b(pack of \d+|\d+\s?(pack|count|ct)|set of \d+)\b/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')).filter(Boolean).join(',');
}

/* ---------- Venmo ---------- */
export interface VenmoPayment { counterparty: string; cents: number; note: string }
export function parseVenmo(text: string): VenmoPayment | null {
  const t = text.replace(/\r/g, '');
  let m = /You paid\s+(.+?)\s+\$([\d,]+\.\d{2})/i.exec(t); let sign = -1;
  if (!m) { m = /(.+?)\s+paid you\s+\$([\d,]+\.\d{2})/i.exec(t); sign = 1; }
  if (!m) return null;
  const after = t.slice(m.index + m[0].length).split('\n').map((l) => l.trim()).filter(Boolean);
  const noteLine = after.find((l) => !/^(transfer date|payment id|venmo|view|see|your|you |privacy|©)/i.test(l) && !/^\$/.test(l));
  return { counterparty: m[1].replace(/^.*\n/, '').trim().slice(0, 80), cents: sign * money(m[2]), note: (noteLine ?? '').slice(0, 200) };
}

/* ---------- PayPal ---------- */
export interface PayPalPayment { merchant: string; cents: number }
export function parsePayPal(text: string): PayPalPayment | null {
  const m = /You (?:sent a payment of|paid)\s+\$([\d,]+\.\d{2})\s*USD\s+to\s+(.+?)(?:\s*\n|\.|$)/i.exec(text);
  return m ? { cents: -money(m[1]), merchant: m[2].trim().slice(0, 80) } : null;
}

export function registerReceiptParsers() {
  const ins = (db: DB, p: { source: string; accountId: number | null; date: string; cents: number; note: string; counterparty?: string; orderRef?: string; eventId: number }) =>
    Number(db.prepare('INSERT INTO external_notes(source, account_id, occurred_on, amount_cents, note, counterparty, order_ref, raw_event_id) VALUES (?,?,?,?,?,?,?,?)').run(p.source, p.accountId, p.date, p.cents, p.note, p.counterparty ?? null, p.orderRef ?? null, p.eventId).lastInsertRowid);
  registerParser({ source: 'amazon_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'amazon')) return { status: 'ok' };
    const o = parseAmazonOrder(extractText(ev.payload)); if (!o) return { status: 'unrecognized', error: 'not an Amazon order confirmation' };
    const h = headersOf(ev);
    if (db.prepare("SELECT 1 FROM external_notes WHERE source='amazon' AND order_ref=? AND amount_cents=?").get(o.orderRef, -o.totalCents)) return done(db, ev, 'amazon', 0); // the same order emailed twice
    const id = ins(db, { source: 'amazon', accountId: ownerAccount(db, h, 'Amazon'), date: receivedDate(ev, h), cents: -o.totalCents, note: amazonNote(o.items) || 'amazon order', orderRef: o.orderRef, eventId: ev.id });
    for (const it of o.items) db.prepare('INSERT INTO external_note_items(external_note_id, name, qty, amount_cents) VALUES (?,?,?,?)').run(id, it.name, it.qty, it.cents);
    runNoteMatcher(db); return done(db, ev, 'amazon', id);
  } });
  registerParser({ source: 'venmo_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'venmo')) return { status: 'ok' };
    const p = parseVenmo(extractText(ev.payload)); if (!p) return { status: 'unrecognized', error: 'not a Venmo payment notice' };
    const h = headersOf(ev);
    const id = ins(db, { source: 'venmo', accountId: ownerAccount(db, h, 'Venmo'), date: receivedDate(ev, h), cents: p.cents, note: p.note, counterparty: p.counterparty, eventId: ev.id });
    runNoteMatcher(db); return done(db, ev, 'venmo', id);
  } });
  registerParser({ source: 'paypal_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'paypal')) return { status: 'ok' };
    const p = parsePayPal(extractText(ev.payload)); if (!p) return { status: 'unrecognized', error: 'not a PayPal payment receipt' };
    const h = headersOf(ev);
    const id = ins(db, { source: 'paypal', accountId: ownerAccount(db, h, 'PayPal'), date: receivedDate(ev, h), cents: p.cents, note: p.merchant, counterparty: p.merchant, eventId: ev.id });
    runNoteMatcher(db); return done(db, ev, 'paypal', id);
  } });
}
