import type { RawEvent } from '../ingest/events.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '', shy: '', zwj: '', ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', copy: '©', reg: '®' };
const decode = (s: string) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, x, n) => {
  const code = d ? Number(d) : x ? parseInt(x, 16) : null;
  if (code !== null) return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  return ENTITIES[n.toLowerCase()] ?? m;
});
// invisible padding that marketing emails use for preheaders (zero-width, soft hyphen, combining grapheme joiner, figure space)
const INVISIBLE = /[​-‏­͏ ⁠﻿]/g;

/**
 * HTML email -> lines of text. Block-level tags break lines; inline tags (span, b, a) do not, so an amount the sender split across
 * elements ("$" "15" "." "00" in Venmo mail) is still readable. Style/script/head are dropped. Never throws.
 */
export function htmlToText(html: string): string {
  const s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/?(?:div|p|tr|td|th|table|h[1-6]|li|ul|ol|section|center|tbody|thead)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(s).replace(INVISIBLE, '').replace(/[ \t  - ]+/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
}

export interface EmailBody { text: string; headers: Record<string, string> }
/** The body the parsers read: the HTML part rendered to lines when the forwarder sent one (its own plain text is often empty or unstructured), else the plain text. */
export function emailBody(ev: RawEvent): EmailBody {
  let headers: Record<string, string> = {};
  try { headers = JSON.parse(ev.headers_json ?? '{}'); } catch { /* none */ }
  const t = ev.payload.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const html = typeof j.html === 'string' && j.html ? htmlToText(j.html) : '';
      const plain = String(j.text ?? j.body ?? j.message ?? '');
      return { text: html || plain, headers };
    } catch { /* fall through */ }
  }
  return { text: t, headers };
}
/** Join an amount the sender broke apart ("$ 15 . 00" / "$\n15\n.\n00") back into "$15.00". */
export const joinAmounts = (s: string) => s.replace(/\$\s*([\d,]+)\s*\.\s*(\d{2})\b/g, '$$$1.$2');
