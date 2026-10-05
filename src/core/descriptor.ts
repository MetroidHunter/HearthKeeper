/** Descriptor cleaning (design §9.2), tuned against ~17k real bank/card descriptors. Never throws; the raw text is always kept alongside. */
export interface CleanedDescriptor { clean: string; locationHint: string | null; authorizedOn: string | null; cardLast4: string | null; ownerHint: 'brys' | 'miracle' | null; refCode: string | null }

const PREFIXES = [/^SQ\s*\*\s*/i, /^TST\s*\*\s*/i, /^DD\s*\*\s*/i, /^PAYPAL\s*\*\s*/i, /^GOOGLE\s*\*\s*/i, /^SP\s+/i, /^PY\s*\*\s*/i];
const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const AMAZON_MKT = /^(?:AMZN MKTP US|AMAZON\.COM|AMAZON MKTPL|AMZN MKTP)\s*\*\s*([A-Z0-9]{6,})\s*$/i;
const P2P = /\b(VENMO|PAYPAL|ZELLE|CASH APP|CASHOUT)\b/i;

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
}

export function cleanDescriptor(raw: string, opts: { year?: number } = {}): CleanedDescriptor {
  let s = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  let authorizedOn: string | null = null, cardLast4: string | null = null, refCode: string | null = null, ownerHint: CleanedDescriptor['ownerHint'] = null;
  let m: RegExpExecArray | null;

  // Wells Fargo debit rows: "PURCHASE AUTHORIZED ON 07/07 <merchant> ... S301189151997605 CARD 4481" (the authorized-on date is the true purchase date)
  if ((m = /^(?:PURCHASE|RECURRING PAYMENT|ATM WITHDRAWAL|PURCHASE RETURN)(?: AUTHORIZED ON)?\s+(\d{2})\/(\d{2})\s+/i.exec(s))) {
    authorizedOn = `${opts.year ?? new Date().getUTCFullYear()}-${m[1]}-${m[2]}`;
    s = s.slice(m[0].length);
  }
  if ((m = /\s+S\d{10,}\s+CARD\s+(\d{4})\s*$/i.exec(s)) || (m = /\s+CARD\s+(\d{4})\s*$/i.exec(s))) { cardLast4 = m[1]; s = s.slice(0, m.index); }
  s = s.replace(/\s+S\d{8,}\s*$/i, '').replace(/\s+(?:\+?1[ -])?\d{3}-\d{3}-\d{4}\b/g, '');               // trailing processor reference and phone numbers

  // Amazon marketplace: every order is a different "merchant" by reference; they are all Amazon (the reference is kept)
  if ((m = AMAZON_MKT.exec(s))) { refCode = m[1]; return { clean: 'AMAZON', locationHint: null, authorizedOn, cardLast4, ownerHint, refCode }; }

  if (P2P.test(s) || /\bTRANSFER\b/i.test(s)) {
    // "VENMO PAYMENT 230730 1028486636483 MIRACLE SEPULVEDA", "ZELLE FROM X ON 10/13 REF # ABC U.S. BANK SEN", "RECURRING TRANSFER TO X REF #OP0SRZNP99 XXXXXX"
    s = s.replace(/\s+REF\s*#\s*\S+.*$/i, '').replace(/\s+ON \d{1,2}\/\d{1,2}\b.*$/i, '').replace(/\s+X{3,}\d*\b/gi, '');
    s = s.replace(/\s+\d{6}\b/g, '').replace(/\s+\d{9,}\b/g, ' ');
    const own = /\s+(?:BRYS(?: KRISTO\w*)?(?: SEPULVEDA)?|MIRACLE(?: C)?(?: SEPULVEDA| THOMAS)?|BUNMIRA)\s*$/i.exec(s);
    if (own) { ownerHint = /MIRACLE|BUNMIRA/i.test(own[0]) ? 'miracle' : 'brys'; s = s.slice(0, own.index); }
  }

  for (const p of PREFIXES) s = s.replace(p, '');
  let locationHint: string | null = null;
  if ((m = /\s*#\s*(\d+)\b/.exec(s))) { locationHint = `#${m[1]}`; s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(); } // store number
  // trailing opaque reference tokens mixing letters and digits (e.g. "GOOGLE *CLOUD ZHK8FF")
  const toks0 = s.split(' ');
  if (toks0.length >= 2 && /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{6,12}$/.test(toks0[toks0.length - 1]) && !/\d{4}$/.test(toks0[toks0.length - 1].slice(0, 0))) { refCode ??= toks0.pop()!; s = toks0.join(' '); }
  // trailing "CITY ST" (Greenlight and bank vendors carry these); a multi-word city is left to merchant aliases
  const tm = /^(.*\S)\s+([A-Z]{2})$/.exec(s);
  if (tm && US_STATES.includes(tm[2])) {
    const toks = tm[1].split(' ');
    // processors add the city in Title Case after an ALL-CAPS merchant ("ATULEA Seattle WA"); otherwise only strip it when enough name remains
    const last = toks[toks.length - 1] ?? '';
    const city = toks.length >= 3 || (toks.length >= 2 && /^[A-Z][a-z]+$/.test(last) && /^[A-Z0-9&'.-]{2,}$/.test(toks[0])) ? toks.pop()! : '';
    locationHint = [locationHint, city, tm[2]].filter(Boolean).join(' ');
    s = toks.join(' ');
  }
  s = s.replace(/[\s*\-_.]+$/, '').trim();
  return { clean: s.toUpperCase(), locationHint, authorizedOn, cardLast4, ownerHint, refCode };
}
