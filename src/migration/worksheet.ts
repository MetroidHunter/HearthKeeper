import { audit, type DB } from '../core/db.js';
import { categoryBalance } from '../core/balance.js';
import { setSplits, suggestCategory } from '../core/transactions.js';
import { suggestionsFor } from '../core/reports.js';
import { cleanDescriptor } from '../core/descriptor.js';
import { loadRules } from '../core/rules.js';

/**
 * Resolution worksheet for the `NEEDS CATEGORY` and blank-category leftovers (design D32, §18.2). Parity is proven first on the unresolved data;
 * this is the separate, audited step that moves money between categories, and it reports the before/after balance of everything it touches.
 */
export interface WorksheetItem { splitId: number; txnId: number; date: string; descriptor: string; amountCents: number; bucket: string; suggestions: { id: number; name: string; why: string }[]; best: number | null }

export function worksheetItems(db: DB): WorksheetItem[] {
  const rows = db.prepare(`SELECT s.id splitId, t.id txnId, t.occurred_on date, t.descriptor_raw descriptor, s.amount_cents amountCents, REPLACE(s.memo,'legacy:','') bucket
    FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id WHERE s.category_id IS NULL AND s.memo LIKE 'legacy:%' AND t.status!='void' ORDER BY t.occurred_on DESC, t.id`).all() as any[];
  const rules = loadRules(db);
  return rows.map((r) => {
    const sug: WorksheetItem['suggestions'] = [];
    const rs = suggestCategory(db, r.descriptor, r.amountCents, 'Legacy', undefined, { readOnly: true, rules });
    if (rs.categoryId) { const c = db.prepare("SELECT id, name FROM categories WHERE id=? AND status='active'").get(rs.categoryId) as any; if (c) sug.push({ ...c, why: 'rule' }); }
    for (const s of suggestionsFor(db, { id: r.txnId, decided_rule_id: null, descriptor_clean: cleanDescriptor(r.descriptor).clean })) if (!sug.some((x) => x.id === s.id)) sug.push(s);
    return { ...r, suggestions: sug.slice(0, 3), best: sug[0]?.id ?? null };
  });
}

export interface ApplyResult { applied: number; skipped: number; balances: { categoryId: number; name: string; before: number | null; after: number | null }[]; pseudoBefore: number; pseudoAfter: number }

/** Apply category assignments to legacy leftovers. Atomic, audited, and reports the balance effect on every category touched. */
export function applyWorksheet(db: DB, assignments: { splitId: number; categoryId: number }[], asOf: string, actor = 'user'): ApplyResult {
  const touched = new Set(assignments.map((a) => a.categoryId));
  const bal = () => Object.fromEntries([...touched].map((id) => [id, categoryBalance(db, id, asOf).total]));
  const pseudo = () => (db.prepare("SELECT COALESCE(SUM(s.amount_cents),0) v FROM transaction_splits s WHERE s.category_id IS NULL AND s.memo LIKE 'legacy:%'").get() as { v: number }).v;
  const before = bal(), pBefore = pseudo();
  let applied = 0, skipped = 0;
  db.transaction(() => {
    for (const a of assignments) {
      const s = db.prepare("SELECT s.id, s.transaction_id, s.amount_cents FROM transaction_splits s WHERE s.id=? AND s.category_id IS NULL AND s.memo LIKE 'legacy:%'").get(a.splitId) as any;
      const cat = db.prepare('SELECT id, kind FROM categories WHERE id=?').get(a.categoryId) as any;
      if (!s || !cat) { skipped++; continue; }
      const t = db.prepare('SELECT legacy_group FROM transactions WHERE id=?').get(s.transaction_id) as any;
      // legacy rows keep their exact (possibly fractional-cent) amounts, so edit the split in place instead of going through the whole-cent validator
      db.prepare("UPDATE transaction_splits SET category_id=?, memo=NULL, origin='user' WHERE id=?").run(a.categoryId, a.splitId);
      db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='user', version=version+1 WHERE id=?").run(s.transaction_id);
      void t; applied++;
    }
    audit(db, 'migration_worksheet', 'apply', 'resolve_needs_category', undefined, { applied, assignments: assignments.length }, actor);
  })();
  const after = bal();
  return { applied, skipped, pseudoBefore: pBefore, pseudoAfter: pseudo(),
    balances: [...touched].map((id) => ({ categoryId: id, name: (db.prepare('SELECT name FROM categories WHERE id=?').get(id) as any).name, before: before[id], after: after[id] })) };
}

export function saveReport(db: DB, report: unknown) { db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)').run('migration_report', JSON.stringify(report)); }
export function loadReport(db: DB): any | null { const r = db.prepare("SELECT value FROM settings WHERE key='migration_report'").get() as { value: string } | undefined; return r ? JSON.parse(r.value) : null; }
