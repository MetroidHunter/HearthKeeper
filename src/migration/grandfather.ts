import { audit, type DB } from '../core/db.js';
import { wrapperSourceOf } from '../notes/matcher.js';

export const SEED_LABEL = 'Predates Oct 2026 Seed';
const FLAG = 'seed_grandfathered';
const FLAG_MARKS = 'seed_flags_cleared';

export interface GrandfatherResult { skipped?: 'already_done' | 'no_legacy_rows'; categorized: number; noted: number; marked: number; flagsCleared: number }
const none = (skipped: GrandfatherResult['skipped']): GrandfatherResult => ({ skipped, categorized: 0, noted: 0, marked: 0, flagsCleared: 0 });
const done = (db: DB, key: string) => !!db.prepare('SELECT 1 FROM settings WHERE key=?').get(key);
const setDone = (db: DB, key: string) => db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, new Date().toISOString());

/**
 * Everything that came from the spreadsheet import is valid as it stands (D58): nothing from before the seed is asked for a
 * category or a note. This touches ONLY rows written by the initial sheet import (their splits carry origin 'legacy'); bank CSV
 * and live-capture transactions are never affected. Uncategorized imported rows move to a reserved, hidden category; wrapper-payment
 * rows (Amazon/Venmo/PayPal) with no note get a note saying why; "???" follow-up marks from the sheet are cleared with that same
 * note; every imported row is marked so later note-matching leaves it alone. Each step runs once and is a no-op on a database
 * with no imported rows. Run after parity has been proven (parity reads the unresolved rows).
 */
export function grandfatherSeed(db: DB, opts: { force?: boolean } = {}): GrandfatherResult {
  const stepA = opts.force || !done(db, FLAG), stepB = opts.force || !done(db, FLAG_MARKS);
  if (!stepA && !stepB) return none('already_done');
  const legacy = (db.prepare("SELECT COUNT(DISTINCT transaction_id) c FROM transaction_splits WHERE origin='legacy'").get() as { c: number }).c;
  if (!legacy) return none('no_legacy_rows');
  return db.transaction((): GrandfatherResult => {
    let categorized = 0, noted = 0, marked = 0, flagsCleared = 0;
    if (stepA) {
      const hasNull = db.prepare("SELECT 1 FROM transaction_splits WHERE category_id IS NULL AND origin='legacy' LIMIT 1").get();
      if (hasNull) {
        const first = (db.prepare("SELECT MIN(t.occurred_on) d FROM transactions t WHERE t.id IN (SELECT transaction_id FROM transaction_splits WHERE origin='legacy')").get() as { d: string | null }).d;
        db.prepare("INSERT OR IGNORE INTO categories(name, kind, discretionary, start_month, status, retired_month, system) VALUES (?, 'income_reference', 0, ?, 'retired', ?, 1)").run(SEED_LABEL, (first ?? '2020-01').slice(0, 7), (first ?? '2020-01').slice(0, 7));
        const sys = (db.prepare('SELECT id FROM categories WHERE name=?').get(SEED_LABEL) as { id: number }).id;
        categorized = db.prepare("UPDATE transaction_splits SET category_id=? WHERE category_id IS NULL AND origin='legacy'").run(sys).changes;
        db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='seed' WHERE review_state='needs_category' AND status!='void' AND id IN (SELECT transaction_id FROM transaction_splits WHERE category_id=?)").run(sys);
      }
      marked = db.prepare("UPDATE transactions SET note_source='seed' WHERE note_source IS NULL AND id IN (SELECT transaction_id FROM transaction_splits WHERE origin='legacy')").run().changes;
      const rows = db.prepare("SELECT id, descriptor_raw, note, note_state FROM transactions WHERE note_source='seed' AND status!='void'").all() as { id: number; descriptor_raw: string; note: string | null; note_state: string }[];
      const upd = db.prepare("UPDATE transactions SET note=?, note_state='not_needed' WHERE id=?");
      for (const r of rows) {
        const wouldNeed = ['needs_note', 'awaiting_note', 'ambiguous'].includes(r.note_state) || (!!wrapperSourceOf(r.descriptor_raw) && !(r.note ?? '').trim());
        if (!wouldNeed) continue;
        upd.run((r.note ?? '').trim() ? r.note : SEED_LABEL, r.id);
        if (!(r.note ?? '').trim()) noted++;
      }
      setDone(db, FLAG);
    }
    if (stepB) {
      // only bare question marks: a real remark such as "FLAG: needs follow-up ..." is the user's own and stays
      const flagged = db.prepare("SELECT id, flag_reason FROM transactions WHERE flagged=1 AND status!='void' AND id IN (SELECT transaction_id FROM transaction_splits WHERE origin='legacy')").all() as { id: number; flag_reason: string | null }[];
      const clear = db.prepare("UPDATE transactions SET flagged=0, flag_reason=NULL, note=?, note_state='not_needed', note_source='seed' WHERE id=?");
      for (const f of flagged) if (/^\s*\?+\s*$/.test(f.flag_reason ?? '')) { clear.run(SEED_LABEL, f.id); flagsCleared++; }
      setDone(db, FLAG_MARKS);
    }
    audit(db, 'migration', 'seed', 'grandfather', undefined, { categorized, noted, marked, flagsCleared, label: SEED_LABEL }, 'migration');
    return { categorized, noted, marked, flagsCleared };
  })();
}
