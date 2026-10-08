import type { DB } from '../core/db.js';
import { audit } from '../core/db.js';
import { classify, ignoreTransaction } from '../core/transactions.js';
import { parseEvent } from '../ingest/events.js';
import { registerGreenlightParser } from './parser.js';
import { runNoteMatcher } from '../notes/matcher.js';

/**
 * A rule per child, so a Greenlight payment lands in that child's category once the Greenlight message has said who it was for:
 * `descriptor contains "greenlight app" AND note contains <name>` → the category the child used to be tied to. Suggest mode, like any new rule; flip it to auto on the Rules page.
 */
export function ensureChildRules(db: DB): number {
  let made = 0;
  const kids = db.prepare('SELECT p.display_name name, c.name category FROM greenlight_profiles p JOIN categories c ON c.id=p.category_id WHERE p.active=1').all() as { name: string; category: string }[];
  for (const k of kids) {
    const note = `greenlight: ${k.name}`;
    if (db.prepare('SELECT 1 FROM rules WHERE notes=?').get(note)) continue;
    db.prepare('INSERT INTO rules(priority,match_json,action_json,mode,origin,notes) VALUES (?,?,?,?,?,?)').run(60,
      JSON.stringify({ all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }, { field: 'note', op: 'contains', value: k.name }] }),
      JSON.stringify({ type: 'categorize', category: k.category }), 'suggest', 'user', note);
    made++;
  }
  return made;
}

export interface RetireResult { rules: number; fundingRestored: number; walletRowsIgnored: number; messagesReprocessed: number; skipped?: boolean }

/**
 * One-time move to "Greenlight is just a payment with a note" (runs once, at server start):
 *  - a rule per child (above);
 *  - the old "greenlight funding = hidden internal transfer" rule goes, and the bank rows it hid come back as ordinary payments that need a category;
 *  - rows the old engine created on the Greenlight wallet (allowances, returns, reclasses, card spending) are ignored, not deleted, so nothing is lost and they can be restored;
 *  - stored Greenlight messages are read again with the new rules, so allowance messages become notes;
 *  - open Greenlight requests are closed (they are no longer tracked).
 */
export function retireGreenlight(db: DB): RetireResult {
  if (db.prepare("SELECT 1 FROM settings WHERE key='greenlight_retired'").get()) return { rules: 0, fundingRestored: 0, walletRowsIgnored: 0, messagesReprocessed: 0, skipped: true };
  const out: RetireResult = { rules: 0, fundingRestored: 0, walletRowsIgnored: 0, messagesReprocessed: 0 };
  registerGreenlightParser();
  db.transaction(() => {
    out.rules = ensureChildRules(db);
    const restore: number[] = [];
    // the seeded "core: greenlight funding" rule, or any rule of that kind (description mentions greenlight app → internal transfer)
    const funding = (db.prepare('SELECT id, match_json, action_json FROM rules').all() as { id: number; match_json: string; action_json: string }[])
      .filter((r) => /greenlight app/i.test(r.match_json) && (() => { try { return JSON.parse(r.action_json).type === 'internal_transfer'; } catch { return false; } })());
    for (const r of funding) {
      for (const t of db.prepare("SELECT id FROM transactions WHERE kind='internal_transfer' AND decided_rule_id=? AND decided_by='rule'").all(r.id) as { id: number }[]) restore.push(t.id);
      db.prepare('DELETE FROM rules WHERE id=?').run(r.id);
    }
    for (const id of restore) {
      db.prepare(`UPDATE transactions SET kind=CASE WHEN amount_cents>0 THEN 'income' ELSE 'spending' END, ignored_reason=NULL, review_state='needs_category', decided_by=NULL, decided_rule_id=NULL,
        transfer_group=NULL, note_state='not_needed', version=version+1 WHERE id=?`).run(id);
      classify(db, id); out.fundingRestored++;
    }
    for (const t of db.prepare("SELECT id FROM transactions WHERE kind IN ('greenlight_allowance','greenlight_return','greenlight_reclass') AND status!='void'").all() as { id: number }[]) {
      ignoreTransaction(db, t.id, 'Greenlight is no longer tracked'); out.walletRowsIgnored++;
    }
    db.prepare("UPDATE greenlight_requests SET status='declined' WHERE status='pending'").run();
    db.prepare('DELETE FROM greenlight_processed').run();
    for (const e of db.prepare("SELECT id FROM raw_events WHERE source='greenlight_msg' ORDER BY id").all() as { id: number }[]) { parseEvent(db, e.id); out.messagesReprocessed++; }
    audit(db, 'greenlight', 'retire', 'retire', undefined, out, 'system');
    db.prepare("INSERT INTO settings(key, value) VALUES ('greenlight_retired', '1')").run();
  })();
  runNoteMatcher(db);
  return out;
}
