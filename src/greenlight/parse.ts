import { DateTime } from 'luxon';
import { HOME_ZONE } from '../core/time.js';
import { parseCents } from '../core/money.js';

/**
 * Greenlight notification parsers (design §11.1, §11.7). One parser per observed shape.
 * The profile always comes from the message text and is never guessed (§11.8 #1).
 */
export type GreenlightEvent =
  | { type: 'spend'; profile: string; amountCents: number; vendor: string }
  | { type: 'final_amount'; profile: string; amountCents: number; vendor: string }
  | { type: 'allowance'; profile: string; amountCents: number }
  | { type: 'allowance_reminder'; profile: string; amountCents: number }
  | { type: 'return'; profile: string; amountCents: number }
  | { type: 'declined'; profile: string; amountCents: number; vendor: string; control: string; reason: string }
  | { type: 'withdraw'; profile: string; amountCents: number; vendor: string }
  | { type: 'request'; profile: string; amountCents: number; detail: string }
  | { type: 'savings_reward'; amountCents: number }
  | { type: 'noise'; reason: string }
  | { type: 'unrecognized'; reason: string };

export interface ParsedGreenlight { event: GreenlightEvent; occurredAtUtc: string | null; pacificDate: string | null; body: string }

const SUFFIX_RES: RegExp[] = [
  /\s+on\s+([A-Z][a-z]+ \d{1,2}, \d{4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)\s*$/i,
  /\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*(?:[AP]M)?)\s*$/i,
];
const FORMATS = ['LLLL d, yyyy h:mma', 'LLLL d, yyyy h:mm a', 'M/d/yyyy h:mma', 'M/d/yyyy h:mm a', 'M/d/yy h:mma', 'M/d/yy h:mm a', 'M/d/yyyy H:mm', 'M/d/yy H:mm'];

/** Strip the IFTTT `on <date> at <time>` suffix and parse it as Pacific, as today's sheet does (§11.1). */
export function splitTimestamp(text: string): { body: string; utc: string | null; pacificDate: string | null } {
  const t = text.trim();
  for (const re of SUFFIX_RES) {
    const m = re.exec(t);
    if (!m) continue;
    const stamp = `${m[1]} ${m[2].toUpperCase().replace(/\s+/g, '')}`;
    for (const f of FORMATS) {
      const dt = DateTime.fromFormat(stamp.replace(/(\d)(AM|PM)$/, '$1$2'), f.replace(' a', 'a'), { zone: HOME_ZONE, locale: 'en-US' });
      if (dt.isValid) return { body: t.slice(0, m.index).trim(), utc: dt.toUTC().toISO(), pacificDate: dt.toISODate() };
    }
  }
  return { body: t, utc: null, pacificDate: null };
}

const NAME = "([A-Z][\\w'’-]*)";
const AMT = '\\$([\\d,]+(?:\\.\\d{1,2})?)';
const c = (s: string) => parseCents(s);

export function parseGreenlight(raw: string): ParsedGreenlight {
  const { body, utc, pacificDate } = splitTimestamp(raw);
  const mk = (event: GreenlightEvent): ParsedGreenlight => ({ event, occurredAtUtc: utc, pacificDate, body });
  let m: RegExpExecArray | null;

  // "Marion's $33.79 purchase at WAL-MART #5393 GREENSBORO NC was declined due to insufficient funds in their GROCERY Spend Control. Tap ..."
  // also: "... was declined." / "... was declined due to insufficient funds on their card. Tap here ..." / "... was declined as they exceeded the number of incorrect PIN attempts."
  if ((m = new RegExp(`^${NAME}[’']s ${AMT} purchase at (.+?) was declined\\b(.*)$`, 'is').exec(body))) {
    const rest = m[4].replace(/\s*Tap here.*$/is, '').replace(/^\s*/, '').replace(/\.\s*$/, '');
    const ctl = /in their (.+?) Spend Control/i.exec(rest);
    return mk({ type: 'declined', profile: m[1], amountCents: c(m[2]), vendor: m[3].trim(), control: (ctl?.[1] ?? '').trim(), reason: rest });
  }
  // "Marion withdrew $23.00 from Fairway Food Mart Greensboro NC." / "Miracle withdrew $20.00 at SOME ATM"
  if ((m = new RegExp(`^${NAME} withdrew ${AMT} (?:at|from) (.+?)\\.?$`, 'i').exec(body)))
    return mk({ type: 'withdraw', profile: m[1], amountCents: c(m[2]), vendor: m[3].trim() });
  // "Marion requests $50.00 to <purpose>" (shape from IFTTT_Code.gs; approval message is still unseen, D23)
  if ((m = new RegExp(`^${NAME} requests ${AMT} to (.+)$`, 'i').exec(body)))
    return mk({ type: 'request', profile: m[1], amountCents: c(m[2]), detail: m[3].trim() });
  // "Marion entered an incorrect PIN. Have them try again ..." (no money moves)
  if (new RegExp(`^${NAME} entered an incorrect PIN`, 'i').test(body)) return mk({ type: 'noise', reason: 'incorrect_pin' });
  // "Miracle's final purchase amount of $25.78 at El Rinconsito Seattle has posted."
  if ((m = new RegExp(`^${NAME}[’']s final purchase amount of ${AMT} at (.+?) has posted\\.?`, 'i').exec(body)))
    return mk({ type: 'final_amount', profile: m[1], amountCents: c(m[2]), vendor: m[3].trim() });
  // "$50.00 allowance transferred to Miracle"
  if ((m = new RegExp(`^${AMT} allowance transferred to ${NAME}`, 'i').exec(body)))
    return mk({ type: 'allowance', profile: m[2], amountCents: c(m[1]) });
  // "Miracle is scheduled to receive $50 allowance tomorrow morning. ..."
  if ((m = new RegExp(`^${NAME} is scheduled to receive ${AMT} allowance`, 'i').exec(body)))
    return mk({ type: 'allowance_reminder', profile: m[1], amountCents: c(m[2]) });
  // "↔️ Miracle moved $38.00 from Spend Anywhere to your Wallet. Tap to view details."
  if ((m = new RegExp(`^(?:[^\\w$]*\\s*)${NAME} moved ${AMT} from (.+?) to your Wallet`, 'iu').exec(body)))
    return mk({ type: 'return', profile: m[1], amountCents: c(m[2]) });
  // "Miracle spent $9.26 at TST* THE LUMBERYARD BA SEATTLE WA"
  if ((m = new RegExp(`^${NAME} spent ${AMT} at (.+)$`, 'i').exec(body)))
    return mk({ type: 'spend', profile: m[1], amountCents: c(m[2]), vendor: m[3].trim() });
  // "Miracle received a $0.07 Greenlight Savings Reward!"
  if ((m = new RegExp(`^${NAME} received an? ${AMT} Greenlight Savings Reward`, 'i').exec(body)))
    return mk({ type: 'savings_reward', amountCents: c(m[2]) });
  // "Marion's Greenlight card is on the way! ..."
  if (new RegExp(`^${NAME}[’']s Greenlight card is on the way`, 'i').test(body)) return mk({ type: 'noise', reason: 'card_shipped' });
  // Restriction notice: names no profile, so it can never be attributed.
  if (/can no longer use their debit card with payment apps/i.test(body)) return mk({ type: 'noise', reason: 'restriction_notice' });
  return mk({ type: 'unrecognized', reason: 'no_matching_shape' });
}
