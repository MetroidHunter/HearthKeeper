import type { DB } from '../core/db.js';
import { pacificDateOfUtc } from '../core/time.js';
import { parseGreenlight } from './parse.js';
import { runNoteMatcher } from '../notes/matcher.js';

/**
 * Greenlight is no longer tracked as accounts, wallets, allowances or reclassifications. Money sent to Greenlight is an ordinary bank payment
 * ("GREENLIGHT APP …") that needs a note, like Amazon, Venmo and PayPal charges; the only thing worth taking from Greenlight's own messages is which
 * child a transfer was for. "$100.00 allowance transferred to Marion" therefore becomes a note ("Marion") that the note matcher attaches to the bank
 * payment of the same amount, and rules on the note ("Greenlight + note contains Marion → Family Support") do the categorizing. Everything the cards
 * themselves do (spending, withdrawals, declines, requests) is deliberately ignored.
 */
export type GreenlightOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'unrecognized'; reason: string }
  | { outcome: 'noise'; reason: string }
  | { outcome: 'note'; noteId: number };

/** Process one captured Greenlight message. Idempotent per raw_event_id (replay-safe). */
export function processGreenlightMessage(db: DB, rawEventId: number, text: string, arrivedAtUtc: string): GreenlightOutcome {
  if (db.prepare('SELECT 1 FROM greenlight_processed WHERE raw_event_id=?').get(rawEventId)) return { outcome: 'duplicate' };
  const p = parseGreenlight(text); const ev = p.event;
  if (ev.type === 'unrecognized') return { outcome: 'unrecognized', reason: ev.reason }; // not terminal: a parser improvement + replay can reprocess it
  if (ev.type !== 'allowance') return { outcome: 'noise', reason: `not_tracked:${ev.type}` };
  const date = p.pacificDate ?? pacificDateOfUtc(arrivedAtUtc);
  const name = ev.profile.trim();
  const noteId = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO external_notes(source, account_id, occurred_on, amount_cents, note, counterparty, order_ref) VALUES (?,?,?,?,?,?,?)')
      .run('greenlight', null, date, ev.amountCents, name, name, `gl:${rawEventId}`).lastInsertRowid);
    db.prepare('INSERT INTO greenlight_processed(raw_event_id, outcome, txn_id, detail_json) VALUES (?,?,?,?)').run(rawEventId, 'note', null, JSON.stringify({ noteId: id, name, cents: ev.amountCents }));
    return id;
  })();
  runNoteMatcher(db); // attach it to the bank payment, if that has arrived (otherwise it waits for it)
  return { outcome: 'note', noteId };
}
