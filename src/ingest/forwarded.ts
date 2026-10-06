import type { DB } from '../core/db.js';
import type { RawEvent, Source } from './events.js';
import { htmlToText } from '../receipts/text.js';

/** Trusted sender domains -> the source their mail is parsed as (the same list the receiver script uses). */
const SENDERS: [RegExp, Source][] = [[/@([a-z0-9-]+\.)*chase\.com$/, 'chase_alert'], [/@([a-z0-9-]+\.)*amazon\.com$/, 'amazon_receipt'], [/@([a-z0-9-]+\.)*venmo\.com$/, 'venmo_receipt'],
  [/@([a-z0-9-]+\.)*paypal\.com$/, 'paypal_receipt'], [/@([a-z0-9-]+\.)*wellsfargo\.com$/, 'wf_notice']];
export const sourceOfSender = (addr: string): Source | null => SENDERS.find(([re]) => re.test(addr))?.[1] ?? null;
export const addrOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

/** DKIM must pass for the sender's own domain (or its parent), or DMARC must pass for it: a message signed by another domain does not qualify. */
export function authenticated(addr: string, authResults: string): boolean {
  const domain = addr.split('@')[1] ?? ''; if (!domain) return false;
  const under = (d: string) => domain === d || domain.endsWith('.' + d);
  for (const m of authResults.matchAll(/dkim=pass[^;]*?header\.[id]=@?([a-z0-9.-]+)/gi)) if (under(m[1].toLowerCase())) return true;
  const dm = /dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/i.exec(authResults);
  return !!dm && under(dm[1].toLowerCase());
}

/**
 * A message a household member forwarded by hand ("---------- Forwarded message ---------- From: Wells Fargo <...>") arrives from a person, so the receiver tags it
 * `email_unknown`. If that person is a known household member (users.email) AND the forward is authenticated as them, take the quoted original sender's source.
 * Anyone else, or an unauthenticated message, stays unknown: the receiver mailbox is reachable by anyone who has its address.
 */
export function forwardedSource(db: DB, ev: Pick<RawEvent, 'channel' | 'source' | 'payload' | 'html' | 'headers_json'>): { source: Source; originalFrom: string } | null {
  if (ev.channel !== 'email' || ev.source !== 'email_unknown') return null;
  let h: Record<string, string> = {}; try { h = JSON.parse(ev.headers_json ?? '{}'); } catch { return null; }
  const outer = addrOf(String(h.From ?? '')); if (!outer) return null;
  const members = (db.prepare('SELECT email FROM users WHERE email IS NOT NULL').all() as { email: string }[]).map((u) => u.email.toLowerCase());
  const extra = (process.env.HK_FORWARDERS ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (![...members, ...extra].includes(outer) || !authenticated(outer, String(h['Authentication-Results'] ?? ''))) return null;
  for (const text of [ev.payload, ev.html ? htmlToText(ev.html) : '']) {
    const at = /-{5,}\s*Forwarded message\s*-{5,}/i.exec(text); if (!at) continue;
    const fm = /^From:\s*(.+)$/mi.exec(text.slice(at.index)); if (!fm) continue;
    const source = sourceOfSender(addrOf(fm[1])); if (source) return { source, originalFrom: fm[1].trim() };
  }
  return null;
}
