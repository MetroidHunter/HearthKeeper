import { audit, type DB } from '../core/db.js';
import { wrapperSourceOf } from '../notes/matcher.js';

export const SEED_LABEL = 'Predates Oct 2026 Seed';
const FLAG = 'seed_grandfathered';

export interface GrandfatherResult { skipped?: 'already_done' | 'no_legacy_rows'; categorized: number; noted: number; marked: number }

/**
 * Everything that came from the spreadsheet import is valid as it stands (D58): nothing from before the seed is asked for a
 * category or a note. Uncategorized rows move to a reserved, hidden category; wrapper-payment rows (Amazon/Venmo/PayPal) with no
 * note get a note saying why; every imported row is marked so later note-matching leaves it alone.
 * Idempotent, and a no-op on a database with no imported rows. Run after parity has been proven (parity reads the unresolved rows).
 */
export function grandfatherSeed(db: DB, opts: { force?: boolean } = {}): GrandfatherResult {
  if (!opts.force && db.prepare('SELECT 1 FROM settings WHERE key=?').get(FLAG)) return { skipped: 'already_done', categorized: 0, noted: 0, marked: 0 };
  const legacy = (db.prepare("SELECT COUNT(DISTINCT transaction_id) c FROM transaction_splits WHERE origin='legacy'").get() as { c: number }).c;
  if (!legacy) return { skipped: 'no_legacy_rows', categorized: 0, noted: 0, marked: 0 };
  return db.transaction((): GrandfatherResult => {
    const hasNull = db.prepare("SELECT 1 FROM transaction_splits WHERE category_id IS NULL AND origin='legacy' LIMIT 1").get();
    let categorized = 0;
    if (hasNull) {
      const first = (db.prepare("SELECT MIN(t.occurred_on) d FROM transactions t WHERE t.id IN (SELECT transaction_id FROM transaction_splits WHERE origin='legacy')").get() as { d: string | null }).d;
      db.prepare("INSERT OR IGNORE INTO categories(name, kind, discretionary, start_month, status, retired_month, system) VALUES (?, 'income_reference', 0, ?, 'retired', ?, 1)").run(SEED_LABEL, (first ?? '2020-01').slice(0, 7), (first ?? '2020-01').slice(0, 7));
      const sys = (db.prepare('SELECT id FROM categories WHERE name=?').get(SEED_LABEL) as { id: number }).id;
      categorized = db.prepare("UPDATE transaction_splits SET category_id=? WHERE category_id IS NULL AND origin='legacy'").run(sys).changes;
      db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='seed' WHERE review_state='needs_category' AND status!='void' AND id IN (SELECT transaction_id FROM transaction_splits WHERE category_id=?)").run(sys);
    }
    const marked = db.prepare("UPDATE transactions SET note_source='seed' WHERE note_source IS NULL AND id IN (SELECT transaction_id FROM transaction_splits WHERE origin='legacy')").run().changes;
    let noted = 0;
    const rows = db.prepare("SELECT id, descriptor_raw, note, note_state FROM transactions WHERE note_source='seed' AND status!='void'").all() as { id: number; descriptor_raw: string; note: string | null; note_state: string }[];
    const upd = db.prepare("UPDATE transactions SET note=?, note_state='not_needed' WHERE id=?");
    for (const r of rows) {
      const wouldNeed = ['needs_note', 'awaiting_note', 'ambiguous'].includes(r.note_state) || (!!wrapperSourceOf(r.descriptor_raw) && !(r.note ?? '').trim());
      if (!wouldNeed) continue;
      upd.run((r.note ?? '').trim() ? r.note : SEED_LABEL, r.id);
      if (!(r.note ?? '').trim()) noted++;
    }
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(FLAG, new Date().toISOString());
    audit(db, 'migration', 'seed', 'grandfather', undefined, { categorized, noted, marked, label: SEED_LABEL }, 'migration');
    return { categorized, noted, marked };
  })();
}
