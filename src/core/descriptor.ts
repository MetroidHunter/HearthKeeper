/** Descriptor cleaning (design §9.2). Returns the merchant-ish name, a location hint, and the true purchase date when embedded. */
export interface CleanedDescriptor { clean: string; locationHint: string | null; authorizedOn: string | null; cardLast4: string | null }

const PREFIXES = [/^SQ\s*\*\s*/i, /^TST\s*\*\s*/i, /^DD\s*\*\s*/i, /^PAYPAL\s*\*\s*/i, /^GOOGLE\s*\*\s*/i, /^AMAZON MKTPL\*\s*/i, /^SP\s+/i, /^PY\s*\*\s*/i];
const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');

export function cleanDescriptor(raw: string, opts: { year?: number } = {}): CleanedDescriptor {
  let s = raw.replace(/\s+/g, ' ').trim();
  let authorizedOn: string | null = null;
  let cardLast4: string | null = null;
  let m: RegExpExecArray | null;

  // Wells Fargo debit rows: "PURCHASE AUTHORIZED ON 07/07 <merchant> ... S301189151997605 CARD 4481"
  if ((m = /^(?:PURCHASE|RECURRING PAYMENT|ATM WITHDRAWAL|PURCHASE RETURN)(?: AUTHORIZED ON)?\s+(\d{2})\/(\d{2})\s+/i.exec(s))) {
    const y = opts.year ?? new Date().getUTCFullYear();
    authorizedOn = `${y}-${m[1]}-${m[2]}`;
    s = s.slice(m[0].length);
  }
  if ((m = /\s+S\d{10,}\s+CARD\s+(\d{4})\s*$/i.exec(s)) || (m = /\s+CARD\s+(\d{4})\s*$/i.exec(s))) {
    cardLast4 = m[1];
    s = s.slice(0, m.index);
  }
  for (const p of PREFIXES) s = s.replace(p, '');
  let locationHint: string | null = null;
  // store number: "#182"
  if ((m = /\s*#\s*(\d+)\b/.exec(s))) { locationHint = `#${m[1]}`; s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(); }
  // trailing "CITY ST" (Greenlight vendors carry these)
  const tm = /^(.*\S)\s+([A-Z]{2})$/.exec(s);
  if (tm && US_STATES.includes(tm[2])) {
    const toks = tm[1].split(' ');
    // The city is the last token when enough name remains; multi-word cities are left to merchant aliases.
    const city = toks.length >= 3 ? toks.pop()! : '';
    locationHint = [locationHint, city, tm[2]].filter(Boolean).join(' ');
    s = toks.join(' ');
  }
  s = s.replace(/[\s*\-_.]+$/, '').trim();
  return { clean: s.toUpperCase(), locationHint, authorizedOn, cardLast4 };
}
