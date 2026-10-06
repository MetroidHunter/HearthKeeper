import { DateTime } from 'luxon';
import type { DB } from '../core/db.js';
import { parseCents } from '../core/money.js';
import { cleanDescriptor } from '../core/descriptor.js';
import { classify, createTransaction } from '../core/transactions.js';
import { fingerprint, registerParser, type RawEvent } from '../ingest/events.js';
import { emitNotify } from '../notify/bus.js';
import { emailBody, joinAmounts } from '../receipts/text.js';

/**
 * Wells Fargo "Your account update is here" alert (daily account rundown), written against two real emails:
 *   Here's the rundown / for account ...5843 / Withdrawals / <DESCRIPTION> / $6.62 / As of 09/26/2026 at 02:26 a.m., Central Time
 * Each line under "Withdrawals" (or "Deposits", same layout, not yet seen in a sample) becomes a provisional transaction on the account whose
 * `last4` matches; the bank CSV later supersedes it exactly like a Chase alert. A balance-only alert has no lines and is unrecognized.
 */
export const WF_PARSER_VERSION = 'wf-1';
export interface WfLine { description: string; cents: number }
export interface WfNotice { last4: string; asOf: string; lines: WfLine[] }

export function parseWfNotice(text: string): WfNotice | null {
  const t = joinAmounts(text).replace(/\s+/g, ' ');
  const acct = /for account \.{2,3}\s?(\d{4})\b/i.exec(t); const asOf = /As of (\d{2})\/(\d{2})\/(\d{4}) at /i.exec(t);
  if (!acct || !asOf) return null;
  const start = t.search(/\b(?:Withdrawals|Deposits)\b/); if (start < 0) return null;
  const body = t.slice(start, asOf.index);
  const lines: WfLine[] = [];
  // sections: "Withdrawals <desc> $x <desc> $y Deposits <desc> $z"
  for (const sec of body.split(/\b(?=Withdrawals\b|Deposits\b)/)) {
    const sign = sec.startsWith('Withdrawals') ? -1 : sec.startsWith('Deposits') ? 1 : 0; if (!sign) continue;
    for (const m of sec.replace(/^(Withdrawals|Deposits)\s*/, '').matchAll(/(.+?)\s*\$([\d,]+\.\d{2})/g)) {
      const description = m[1].trim(); if (description) lines.push({ description, cents: sign * parseCents(m[2].replace(/,/g, '')) });
    }
  }
  return lines.length ? { last4: acct[1], asOf: `${asOf[3]}-${asOf[1]}-${asOf[2]}`, lines } : null;
}

/** The purchase date when the line carries one ("PURCHASE AUTHORIZED ON 09/29"), else the alert date; a December purchase in a January alert belongs to the previous year. */
export function lineDate(description: string, asOf: string): string {
  const c = cleanDescriptor(description, { year: Number(asOf.slice(0, 4)) });
  if (!c.authorizedOn) return asOf;
  const d = DateTime.fromISO(c.authorizedOn);
  return (d.isValid && d > DateTime.fromISO(asOf).plus({ days: 1 }) ? d.minus({ years: 1 }) : d).toISODate()!;
}

export function registerWfNoticeParser() {
  registerParser({ source: 'wf_notice', version: WF_PARSER_VERSION, parse(db: DB, ev: RawEvent) {
    if (db.prepare('SELECT 1 FROM event_results WHERE raw_event_id=? AND parser=?').get(ev.id, 'wf')) return { status: 'ok' };
    const { text, headers } = emailBody(ev);
    const addr = (/<([^>]+)>/.exec(String(headers.From ?? ''))?.[1] ?? String(headers.From ?? '')).trim().toLowerCase();
    if (ev.channel === 'email' && headers.From && !/@([a-z0-9-]+\.)*wellsfargo\.com$/.test(addr)) return { status: 'unrecognized', error: `sender ${addr || '?'} is not wellsfargo.com` };
    const n = parseWfNotice(text);
    if (!n) return { status: 'unrecognized', error: `no Wells Fargo account update shape: ${fingerprint(ev.payload).slice(0, 80)}` };
    const acct = db.prepare("SELECT id FROM accounts WHERE institution='Wells Fargo' AND last4=? AND in_system=1").all(n.last4) as { id: number }[];
    if (acct.length !== 1) return { status: 'error', error: acct.length ? `more than one Wells Fargo account ends in ${n.last4}` : `no Wells Fargo account has last 4 digits ${n.last4}: set it in Settings, then replay` };
    const accountId = acct[0].id; const outcomes: string[] = [];
    for (const l of n.lines) {
      const occurredOn = lineDate(l.description, n.asOf); const raw = l.description.replace(/\s+/g, ' ').trim();
      const key = raw.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3).slice(0, 4);
      // already here: the same alert twice, or the bank file imported first (the posted row wins; nothing to add)
      const same = (db.prepare("SELECT descriptor_raw FROM transactions WHERE account_id=? AND amount_cents=? AND status IN ('provisional','posted','stale') AND superseded_by IS NULL AND ABS(julianday(occurred_on)-julianday(?))<=3").all(accountId, l.cents, occurredOn) as { descriptor_raw: string }[])
        .some((r) => { const d = r.descriptor_raw.toLowerCase(); return d === raw.toLowerCase() || (key.length > 0 && key.every((k) => d.includes(k))); });
      if (same) { outcomes.push('duplicate'); continue; }
      const id = createTransaction(db, { accountId, kind: 'spending', status: 'provisional', occurredOn, amountCents: l.cents, descriptor: raw, sourceEventIds: [ev.id] });
      classify(db, id);
      if ((db.prepare('SELECT review_state r FROM transactions WHERE id=?').get(id) as { r: string }).r === 'needs_category') emitNotify({ type: 'needs_you', txnId: id, lane: 'fast' });
      outcomes.push(`created:${id}`);
    }
    const firstId = Number(/created:(\d+)/.exec(outcomes.join(' '))?.[1] ?? 0) || null;
    db.prepare('INSERT INTO event_results(raw_event_id, parser, outcome, txn_id) VALUES (?,?,?,?)').run(ev.id, 'wf', outcomes.join(','), firstId);
    return { status: 'ok' };
  } });
}
