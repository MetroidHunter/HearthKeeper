import { DateTime } from 'luxon';
import type { DB } from '../core/db.js';
import { CHASE_ZONE, HOME_ZONE } from '../core/time.js';
import { parseCents } from '../core/money.js';
import { classify, createTransaction } from '../core/transactions.js';
import { fingerprint, registerParser, type RawEvent } from '../ingest/events.js';
import { emitNotify } from '../notify/bus.js';
import { extractText } from '../greenlight/parser.js';

/**
 * Chase card alert -> provisional transaction (design §8.5). The real shape comes from IFTTT_Code.gs:
 *   "Prime Visa: You made a $12.30 transaction with SQ *CAFE on Oct 3, 2026 at 4:11 PM ET."
 * Chase sends Eastern wall-clock times; we parse them with a real tz database at the alert's own date (no run-time DST hack).
 * The sentence is searched for (not anchored) so the same parser reads an email body that wraps it.
 */
const RE = /(?:Prime Visa:\s*)?You made an? \$([\d,]+(?:\.\d{1,2})?) transaction with (.+?) on ([A-Za-z]+\.? \d{1,2}, \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}) at (\d{1,2}:\d{2}(?:\s?[AP]M)?) ET\b/i;
const FORMATS = ['MMM d, yyyy h:mm a', 'MMMM d, yyyy h:mm a', 'MMM d, yyyy H:mm', 'MMMM d, yyyy H:mm', 'M/d/yyyy h:mm a', 'M/d/yy h:mm a', 'M/d/yyyy H:mm', 'M/d/yy H:mm'];

export interface ChaseAlert { amountCents: number; vendor: string; authorizedAtUtc: string; occurredOn: string }

export function parseChaseAlert(text: string): ChaseAlert | null {
  const m = RE.exec(text.replace(/\s+/g, ' '));
  if (!m) return null;
  const time = m[4].toUpperCase().replace(/(\d)(AM|PM)$/, '$1 $2');
  const stamp = `${m[3].replace(/\./, '')} ${time}`;
  for (const f of FORMATS) {
    const dt = DateTime.fromFormat(stamp, f, { zone: CHASE_ZONE, locale: 'en-US' });
    if (dt.isValid) return { amountCents: -parseCents(m[1]), vendor: m[2].trim(), authorizedAtUtc: dt.toUTC().toISO()!, occurredOn: dt.setZone(HOME_ZONE).toISODate()! };
  }
  return null;
}

export const CHASE_PARSER_VERSION = 'chase-1';

export function chaseAccountId(db: DB): number | null {
  const a = db.prepare("SELECT id FROM accounts WHERE institution='Chase' AND type='credit_card' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  return a?.id ?? null;
}

export function registerChaseParser() {
  registerParser({
    source: 'chase_alert', version: CHASE_PARSER_VERSION,
    parse(db: DB, ev: RawEvent) {
      if (db.prepare('SELECT 1 FROM event_results WHERE raw_event_id=? AND parser=?').get(ev.id, 'chase')) return { status: 'ok' };
      const from = (() => { try { return String(JSON.parse(ev.headers_json ?? '{}').From ?? ''); } catch { return ''; } })();
      const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
      if (ev.channel === 'email' && from && !/@([a-z0-9-]+\.)*chase\.com$/.test(addr)) return { status: 'unrecognized', error: `sender ${addr || '?'} is not chase.com` }; // anyone can email the receiver mailbox
      const alert = parseChaseAlert(extractText(ev.payload));
      if (!alert) return { status: 'unrecognized', error: `no chase alert shape: ${fingerprint(ev.payload).slice(0, 80)}` };
      const accountId = chaseAccountId(db);
      if (!accountId) return { status: 'error', error: 'no Chase credit_card account configured' };
      // two phones can receive the same alert: the raw layer de-dupes identical text; this also guards near-identical re-sends
      const dup = db.prepare("SELECT id FROM transactions WHERE account_id=? AND status='provisional' AND authorized_at=? AND amount_cents=? AND descriptor_raw=?").get(accountId, alert.authorizedAtUtc, alert.amountCents, alert.vendor) as { id: number } | undefined;
      let txnId = dup?.id;
      if (!txnId) {
        txnId = createTransaction(db, { accountId, kind: 'spending', status: 'provisional', occurredOn: alert.occurredOn, authorizedAt: alert.authorizedAtUtc, amountCents: alert.amountCents, descriptor: alert.vendor, sourceEventIds: [ev.id] });
        classify(db, txnId);
        if ((db.prepare('SELECT review_state r FROM transactions WHERE id=?').get(txnId) as { r: string }).r === 'needs_category') emitNotify({ type: 'needs_you', txnId, lane: 'fast' });
      }
      db.prepare('INSERT INTO event_results(raw_event_id, parser, outcome, txn_id) VALUES (?,?,?,?)').run(ev.id, 'chase', dup ? 'duplicate' : 'created', txnId);
      return { status: 'ok' };
    },
  });
}
