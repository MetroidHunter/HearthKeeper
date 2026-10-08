import type { DB } from '../core/db.js';
import { audit } from '../core/db.js';
import { cleanDescriptor } from '../core/descriptor.js';
import { daysBetween } from '../core/time.js';
import { ignoreTransaction } from '../core/transactions.js';
import { normalizeDescriptor, type ParsedRow } from './csv.js';

/** Word overlap between two bank descriptions (0..1, relative to the shorter one). Shared by alert matching and history matching. */
const tokens = (s: string) => new Set(normalizeDescriptor(s).split(' ').filter((t) => t.length > 2));
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * The history imported from the old sheet lives on its own account ("Legacy", not in the system), so a bank file that overlaps it (the first days after the
 * cut-over) used to be added on top of it and counted twice. A bank row is the same payment as a history row when the amount is exactly equal, the dates are
 * within three days, and the descriptions agree (the same cleaned name, or enough shared words). Descriptions must agree: an equal amount alone is never enough,
 * because silently dropping a real payment is worse than showing a duplicate you can see.
 */
export const HISTORY_WINDOW_DAYS = 3;
export function sameDescription(a: string, b: string): boolean {
  const ca = normalizeDescriptor(cleanDescriptor(a).clean), cb = normalizeDescriptor(cleanDescriptor(b).clean);
  return (!!ca && ca === cb) || similarity(a, b) >= 0.5;
}

interface Hist { id: number; occurred_on: string; amount_cents: number; descriptor_raw: string }
function claimsFor(db: DB, ids: number[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>(); if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) { const part = ids.slice(i, i + 500); for (const c of db.prepare(`SELECT legacy_id id, fingerprint fp FROM history_claims WHERE legacy_id IN (${part.map(() => '?').join(',')})`).all(...part) as { id: number; fp: string }[]) (out.get(c.id) ?? out.set(c.id, new Set()).get(c.id)!).add(c.fp); }
  return out;
}
function historyBetween(db: DB, from: string, to: string): Map<number, Hist[]> {
  const rows = db.prepare(`SELECT t.id, t.occurred_on, t.amount_cents, t.descriptor_raw FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE a.in_system=0 AND t.status!='void' AND t.kind IN ('spending','income','internal_transfer','ignored') AND t.occurred_on BETWEEN date(?, '-${HISTORY_WINDOW_DAYS} day') AND date(?, '+${HISTORY_WINDOW_DAYS} day')`).all(from, to) as Hist[];
  const by = new Map<number, Hist[]>(); for (const r of rows) (by.get(r.amount_cents) ?? by.set(r.amount_cents, []).get(r.amount_cents)!).push(r);
  return by;
}

/** One-to-one assignment of incoming rows to history rows (same-day matches first, then within the window). Deterministic, so re-importing a file gives the same answer. */
export function matchHistory<T extends { date: string; amountCents: number; description: string }>(db: DB, rows: T[], fp: (r: T) => string): Map<T, number> {
  const out = new Map<T, number>(); if (!rows.length) return out;
  const dates = rows.map((r) => r.date).sort(); const by = historyBetween(db, dates[0], dates[dates.length - 1]);
  if (!by.size) return out;
  // a history row already recognised as a different bank row is not available again; the same row (a re-import) may claim it again
  const claims = claimsFor(db, [...by.values()].flat().map((h) => h.id));
  const taken = new Set<number>();
  for (const maxDays of [0, HISTORY_WINDOW_DAYS]) {
    for (const r of rows) {
      if (out.has(r)) continue;
      const best = (by.get(r.amountCents) ?? []).filter((h) => !taken.has(h.id) && (!claims.get(h.id)?.size || claims.get(h.id)!.has(fp(r))) && Math.abs(daysBetween(h.occurred_on, r.date)) <= maxDays && sameDescription(h.descriptor_raw, r.description))
        .map((h) => ({ h, d: Math.abs(daysBetween(h.occurred_on, r.date)), s: similarity(h.descriptor_raw, r.description) })).sort((a, b) => a.d - b.d || b.s - a.s || a.h.id - b.h.id)[0];
      if (best) { out.set(r, best.h.id); taken.add(best.h.id); }
    }
  }
  return out;
}

/** Remember which history row each recognised bank row was, so later checks agree with this one. */
export function claimHistory<T>(db: DB, m: Map<T, number>, fp: (r: T) => string) {
  const ins = db.prepare('INSERT OR IGNORE INTO history_claims(legacy_id, fingerprint) VALUES (?,?)');
  for (const [r, id] of m) ins.run(id, fp(r));
}

/**
 * Clean up rows that were imported on top of history before the check above existed (and re-check after every import). Each bank-file row that matches a
 * history row is hidden as "duplicate of earlier history" (kept, with its fingerprint, so re-importing the file cannot bring it back; restorable from
 * Transactions → Show hidden). If you had already answered the bank row yourself, your answer, note and flag move onto the history row first.
 */
export function dedupeAgainstHistory(db: DB, range?: { from: string; to: string }): { duplicates: number } {
  const cand = db.prepare(`SELECT t.id, t.occurred_on date, t.amount_cents amountCents, t.descriptor_raw description, t.review_state rs, t.note, t.flagged, t.flag_reason FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE a.in_system=1 AND t.fingerprint IS NOT NULL AND t.status!='void' AND t.kind IN ('spending','income') ${range ? 'AND t.occurred_on BETWEEN ? AND ?' : ''} ORDER BY t.occurred_on, t.id`).all(...(range ? [range.from, range.to] : [])) as
    { id: number; date: string; amountCents: number; description: string; rs: string; note: string | null; flagged: number; flag_reason: string | null }[];
  if (!cand.length) return { duplicates: 0 };
  const fpOf = new Map(db.prepare('SELECT id, fingerprint FROM transactions WHERE id IN (' + cand.map(() => '?').join(',') + ')').all(...cand.map((c) => c.id)).map((r: any) => [r.id, r.fingerprint as string]));
  const m = matchHistory(db, cand, (c) => fpOf.get(c.id) ?? String(c.id)); let n = 0;
  db.transaction(() => {
    for (const [c, histId] of m) {
      if (c.rs === 'user_confirmed') { // the person already decided on the bank row: keep that decision
        const h = db.prepare('SELECT review_state rs FROM transactions WHERE id=?').get(histId) as { rs: string };
        const splits = db.prepare('SELECT category_id, amount_cents, memo, origin FROM transaction_splits WHERE transaction_id=?').all(c.id) as any[];
        if (splits.length) {
          db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(histId);
          const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,?)');
          for (const s of splits) ins.run(histId, s.category_id, s.amount_cents, s.memo, s.origin === 'legacy' ? 'user' : s.origin);
          db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='user' WHERE id=?").run(histId);
        }
        void h;
      }
      db.prepare('UPDATE transactions SET note=COALESCE(note, ?), flagged=MAX(flagged, ?), flag_reason=COALESCE(flag_reason, ?) WHERE id=?').run(c.note, c.flagged, c.flag_reason, histId);
      db.prepare('UPDATE external_notes SET matched_txn_id=? WHERE matched_txn_id=?').run(histId, c.id);
      db.prepare('INSERT OR IGNORE INTO history_claims(legacy_id, fingerprint) VALUES (?,?)').run(histId, fpOf.get(c.id) ?? String(c.id));
      ignoreTransaction(db, c.id, 'duplicate of earlier history', 'system');
      audit(db, 'transaction', c.id, 'duplicate_of_history', undefined, { historyId: histId }, 'system');
      n++;
    }
  })();
  return { duplicates: n };
}
