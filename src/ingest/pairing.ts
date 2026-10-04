import type { DB } from '../core/db.js';
import { daysBetween } from '../core/time.js';

/**
 * Paired in-system transfers (design §8.8). Two rows on in-system accounts with opposite signs and equal amounts within ~3 days are linked
 * and both legs become internal_transfer. Equal-and-opposite alone is not enough within one institution: a transfer-like descriptor is required
 * (a refund that matches a purchase is not a transfer). Across institutions, descriptor evidence on at least one leg is required.
 */
const TRANSFER_LIKE = /(transfer|payment thank you|chase credit crd|autopay|online pmt|epay|crd epay|credit card|greenlight app|move money|xfer)/i;
export interface PairResult { paired: number; unpaired: number[] }

export function pairTransfers(db: DB, windowDays = 3): PairResult {
  const rows = db.prepare(`SELECT t.id, t.account_id, t.occurred_on, t.amount_cents, t.descriptor_raw, t.kind, a.institution FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE a.in_system=1 AND a.type!='greenlight_wallet' AND t.status!='void' AND t.transfer_group IS NULL AND t.kind IN ('spending','income','internal_transfer') AND t.decided_by IS NOT 'user'`).all() as any[];
  const outs = rows.filter((r) => r.amount_cents < 0), ins = rows.filter((r) => r.amount_cents > 0);
  const used = new Set<number>();
  let paired = 0;
  const cands: { o: any; i: any; dist: number }[] = [];
  for (const o of outs) for (const i of ins) {
    if (o.account_id === i.account_id || o.amount_cents !== -i.amount_cents) continue;
    const d = Math.abs(daysBetween(o.occurred_on, i.occurred_on));
    if (d > windowDays) continue;
    if (!(TRANSFER_LIKE.test(o.descriptor_raw) || TRANSFER_LIKE.test(i.descriptor_raw))) continue;
    cands.push({ o, i, dist: d });
  }
  cands.sort((a, b) => a.dist - b.dist || a.o.id - b.o.id);
  for (const { o, i } of cands) {
    if (used.has(o.id) || used.has(i.id)) continue;
    used.add(o.id); used.add(i.id);
    const g = o.id;
    for (const t of [o, i]) {
      db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(t.id);
      db.prepare("UPDATE transactions SET kind='internal_transfer', transfer_group=?, review_state='not_needed', ignored_reason='paired_transfer', version=version+1 WHERE id=?").run(g, t.id);
    }
    paired++;
  }
  return { paired, unpaired: unpairedLegs(db) };
}

/** Legs classified internal_transfer by descriptor whose partner never appeared once the other source has caught up past that date (flag for review). */
export function unpairedLegs(db: DB): number[] {
  const rows = db.prepare(`SELECT t.id, t.occurred_on, a.institution FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE t.kind='internal_transfer' AND t.transfer_group IS NULL AND t.status!='void' AND UPPER(t.descriptor_raw) NOT LIKE 'GREENLIGHT APP%'`).all() as any[];
  const latestByInst = new Map<string, string>(
    (db.prepare("SELECT a.institution i, MAX(t.occurred_on) d FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.status!='void' GROUP BY a.institution").all() as any[]).map((r) => [r.i, r.d]));
  return rows.filter((r) => {
    // Partner would live in some other institution; flagged only when every other in-system institution's data extends past this date + window.
    const others = [...latestByInst.entries()].filter(([inst]) => inst !== r.institution);
    return others.length > 0 && others.every(([, d]) => daysBetween(r.occurred_on, d) > 3);
  }).map((r) => r.id);
}
