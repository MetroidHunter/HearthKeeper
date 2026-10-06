import { DateTime } from 'luxon';
import type { DB } from '../core/db.js';
import { parseCents } from '../core/money.js';
import { HOME_ZONE } from '../core/time.js';
import { registerParser, type ParseResult, type RawEvent } from '../ingest/events.js';
import { emailBody, joinAmounts } from './text.js';
import { runNoteMatcher } from '../notes/matcher.js';

/**
 * Receipt parsers (design §10.1, §19.2), written against real emails (fixtures in test/fixtures/receipts, personal details replaced):
 * Amazon "Ordered N items" confirmation, Venmo paid/received, PayPal receipt (RT000403) and PayPal merchant payment (RT001736).
 *  - strict or unrecognized: a message that does not match every required field is `unrecognized`, never half-parsed;
 *  - they only create `external_notes` (a pool the matcher draws from), never transactions;
 *  - only the formats above are verified; other Amazon/Venmo/PayPal mail (shipping, requests, refunds) is left unrecognized on purpose.
 */
export const RECEIPT_PARSER_VERSION = 'receipts-1';

interface Headers { [k: string]: string }
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
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** "Sep 12, 2026" or "July 22, 2026" -> ISO date (the date printed in the body is the payment date; the Date header is only a fallback). */
export function longDate(s: string): string | null {
  const m = /\b([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})\b/.exec(s); const mi = m ? MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()) : -1;
  return m && mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
/** The line after the first line equal to `label` (case-insensitive). */
const after = (lines: string[], label: string, skip = 1) => { const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase()); return i >= 0 ? lines[i + skip] : undefined; };
const done = (db: DB, ev: RawEvent, parser: string, noteIds: number[]): ParseResult => { db.prepare('INSERT OR IGNORE INTO event_results(raw_event_id, parser, outcome, txn_id) VALUES (?,?,?,NULL)').run(ev.id, parser, noteIds.length ? `note:${noteIds.join(',')}` : 'duplicate'); return { status: 'ok' }; };
const seen = (db: DB, ev: RawEvent, parser: string) => !!db.prepare('SELECT 1 FROM event_results WHERE raw_event_id=? AND parser=?').get(ev.id, parser);

/* ---------- Amazon order confirmation ("Ordered 3 items: Pet Supplies, Skin Care") ---------- */
export interface AmazonOrder { orderRef: string; totalCents: number; items: { name: string; qty: number; cents: number }[] }
/**
 * One email can carry several orders (each with its own "Order #" and "Grand Total"). The email names no products, only a category summary per
 * order ("2 items: 1 Pet Supplies, 1 Skin Care") when the HTML part is available, so that is all the note can say.
 */
export function parseAmazonOrders(text: string): AmazonOrder[] {
  const t = joinAmounts(text);
  const out: AmazonOrder[] = [];
  const re = /Order #\s*‫?(\d{3}-\d{7}-\d{7})/g; const starts: { ref: string; at: number }[] = [];
  for (let m; (m = re.exec(t));) starts.push({ ref: m[1], at: m.index });
  starts.forEach((s, i) => {
    const seg = t.slice(s.at, starts[i + 1]?.at ?? t.length);
    const tot = /Grand Total:?\s*(?:\$\s*)?([\d,]+(?:\.\d{1,2})?)\s*(?:USD)?/i.exec(seg);
    if (!tot) return;
    // the summary line sits just before the order's "Order #", after the previous order's block
    const before = t.slice(i ? starts[i - 1].at : 0, s.at);
    const sum = [...before.matchAll(/^\d+ items?: (.+)$/gm)].pop();
    const items = sum ? sum[1].split(/,\s*(?=\d+ )/).map((p) => { const q = /^(?:(\d+) )?(.+)$/.exec(p.trim())!; return { name: q[2], qty: q[1] ? Number(q[1]) : 1, cents: 0 }; }) : [];
    out.push({ orderRef: s.ref, totalCents: money(tot[1]), items });
  });
  return out;
}
/** The skills' convention: a short, lowercase, comma-separated list of nouns ("bags,photo sleeves,cardstock"). */
export function amazonNote(items: { name: string }[]): string {
  return items.map((i) => i.name.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').split(/[,;|:–-]/)[0].replace(/\b(pack of \d+|\d+\s?(pack|count|ct)|set of \d+)\b/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')).filter(Boolean).join(',');
}

/* ---------- Venmo ("You paid X $178.00" / "X paid you $15.00") ---------- */
export interface VenmoPayment { counterparty: string; cents: number; note: string; date: string | null; txnId: string | null }
export function parseVenmo(text: string): VenmoPayment | null {
  const lines = joinAmounts(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines.find((l) => /^You paid .+ \$[\d,]+\.\d{2}$/.test(l) || /^.+ paid you \$[\d,]+\.\d{2}$/.test(l));
  if (!title) return null;
  const out = /^You paid (.+) \$([\d,]+\.\d{2})$/.exec(title);
  const inn = out ? null : /^(.+) paid you \$([\d,]+\.\d{2})$/.exec(title);
  const m = out ?? inn!;
  if (!lines.includes('Transaction details') || !lines.some((l) => /^Transaction ID$/i.test(l))) return null;
  // the memo is the line just above "See transaction" (after the title and the amount, which this layout repeats); "to Group" style memos are the sender's text
  const see = lines.findIndex((l) => /^See transaction$/i.test(l));
  const memo = see > 0 ? lines[see - 1] : '';
  const titleBase = out ? `You paid ${m[1]}` : `${m[1]} paid you`;
  const note = memo && memo !== titleBase && !/^\$?[\d,.]+$/.test(memo) && memo !== title ? memo : '';
  return { counterparty: m[1].trim().slice(0, 80), cents: (out ? -1 : 1) * money(m[2]), note: note.slice(0, 200), date: longDate(after(lines, 'Date') ?? ''), txnId: after(lines, 'Transaction ID') ?? null };
}

/* ---------- PayPal: receipt for a payment (RT000403) and merchant payment confirmation (RT001736) ---------- */
export interface PayPalPayment { merchant: string; cents: number; date: string | null; txnId: string | null; statement: string | null; items: { name: string; qty: number; cents: number }[] }
export function parsePayPal(text: string): PayPalPayment | null {
  const lines = joinAmounts(text).split('\n').map((l) => l.trim()).filter(Boolean);
  // merchant payment confirmation: "You paid $13.65 USD to Hulu"
  const top = lines.map((l) => /^You paid \$([\d,]+\.\d{2}) USD to (.+)$/.exec(l)).find(Boolean);
  if (top) {
    const total = lines.map((l, i) => (l === 'Total' ? /^\$([\d,]+\.\d{2}) USD$/.exec(lines[i + 1] ?? '') : null)).find(Boolean);
    if (!total || money(total[1]) !== money(top[1])) return null;
    const items: PayPalPayment['items'] = [];
    lines.forEach((l, i) => { const q = /^Qty:\s*(\d+)$/i.exec(l); const pr = /^\$([\d,]+\.\d{2})$/.exec(lines[i + 1] ?? ''); if (q && pr && i > 0) items.push({ name: lines[i - 1].slice(0, 140), qty: Number(q[1]), cents: money(pr[1]) }); });
    const tid = lines.map((l) => /^Transaction ID:\s*(\S+)$/.exec(l)?.[1]).find(Boolean);
    return { merchant: top[2].trim().slice(0, 80), cents: -money(top[1]), date: longDate(after(lines, 'Transaction date') ?? ''), txnId: tid ?? null, statement: null, items };
  }
  // receipt: "Payment to <name> <email>", "Total $5.00 USD", "will appear on your statement as ..."
  const to = after(lines, 'Payment to');
  const totalLine = lines.map((l, i) => (l === 'Total' ? /^\$([\d,]+\.\d{2}) USD$/.exec(lines[i + 1] ?? '') : null)).find(Boolean);
  if (!to || !totalLine || !lines.some((l) => /thanks for paying with PayPal/i.test(l))) return null;
  const st = lines.map((l) => /appear on your statement as (.+)$/i.exec(l)?.[1]).find(Boolean);
  return { merchant: to.slice(0, 80), cents: -money(totalLine[1]), date: longDate(after(lines, 'Date') ?? ''), txnId: after(lines, 'Transaction ID') ?? null, statement: st ?? null, items: [] };
}

export function registerReceiptParsers() {
  const ins = (db: DB, p: { source: string; accountId: number | null; date: string; cents: number; note: string; counterparty?: string; orderRef?: string; eventId: number }) =>
    Number(db.prepare('INSERT INTO external_notes(source, account_id, occurred_on, amount_cents, note, counterparty, order_ref, raw_event_id) VALUES (?,?,?,?,?,?,?,?)').run(p.source, p.accountId, p.date, p.cents, p.note, p.counterparty ?? null, p.orderRef ?? null, p.eventId).lastInsertRowid);
  const items = (db: DB, id: number, its: { name: string; qty: number; cents: number }[]) => { for (const it of its) db.prepare('INSERT INTO external_note_items(external_note_id, name, qty, amount_cents) VALUES (?,?,?,?)').run(id, it.name, it.qty, it.cents); };
  // the same Venmo/PayPal transaction id forwarded twice (or by both partners) is one note
  const dupRef = (db: DB, source: string, ref: string | null) => !!ref && !!db.prepare('SELECT 1 FROM external_notes WHERE source=? AND order_ref=?').get(source, ref);
  registerParser({ source: 'amazon_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'amazon')) return { status: 'ok' };
    const { text, headers: h } = emailBody(ev); const orders = parseAmazonOrders(text);
    if (!orders.length) return { status: 'unrecognized', error: 'not an Amazon order confirmation' };
    const date = receivedDate(ev, h), account = ownerAccount(db, h, 'Amazon'); const ids: number[] = [];
    for (const o of orders) {
      if (db.prepare("SELECT 1 FROM external_notes WHERE source='amazon' AND order_ref=? AND amount_cents=?").get(o.orderRef, -o.totalCents)) continue; // the same order emailed twice
      const id = ins(db, { source: 'amazon', accountId: account, date, cents: -o.totalCents, note: amazonNote(o.items) || 'amazon order', orderRef: o.orderRef, eventId: ev.id });
      items(db, id, o.items); ids.push(id);
    }
    runNoteMatcher(db); return done(db, ev, 'amazon', ids);
  } });
  registerParser({ source: 'venmo_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'venmo')) return { status: 'ok' };
    const { text, headers: h } = emailBody(ev); const p = parseVenmo(text); if (!p) return { status: 'unrecognized', error: 'not a Venmo payment notice' };
    if (dupRef(db, 'venmo', p.txnId)) return done(db, ev, 'venmo', []);
    const id = ins(db, { source: 'venmo', accountId: ownerAccount(db, h, 'Venmo'), date: p.date ?? receivedDate(ev, h), cents: p.cents, note: p.note, counterparty: p.counterparty, orderRef: p.txnId ?? undefined, eventId: ev.id });
    runNoteMatcher(db); return done(db, ev, 'venmo', [id]);
  } });
  registerParser({ source: 'paypal_receipt', version: RECEIPT_PARSER_VERSION, parse(db, ev) {
    if (seen(db, ev, 'paypal')) return { status: 'ok' };
    const { text, headers: h } = emailBody(ev); const p = parsePayPal(text); if (!p) return { status: 'unrecognized', error: 'not a PayPal payment receipt' };
    if (dupRef(db, 'paypal', p.txnId)) return done(db, ev, 'paypal', []);
    const id = ins(db, { source: 'paypal', accountId: ownerAccount(db, h, 'PayPal'), date: p.date ?? receivedDate(ev, h), cents: p.cents, note: p.merchant, counterparty: p.merchant, orderRef: p.txnId ?? undefined, eventId: ev.id });
    items(db, id, p.items);
    runNoteMatcher(db); return done(db, ev, 'paypal', [id]);
  } });
}
