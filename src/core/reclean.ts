import type { DB } from './db.js';
import { cleanDescriptor } from './descriptor.js';
import { classify, resolveMerchant } from './transactions.js';

/** Bump when cleanDescriptor changes in a way that should also fix transactions that are already stored. */
export const DESCRIPTOR_VERSION = 2;

/**
 * One-time repair after the cleaner improves: recompute the cleaned name of every stored transaction, move the ones that changed to the right merchant
 * (creating it if needed), and re-run the rules on those still waiting for a category. Categories, notes and splits you set are never touched, and the
 * raw text (what rules and re-imports use) is never changed. Merchants left empty and never reviewed are removed.
 */
export function recleanDescriptors(db: DB): { changed: number; merchantsRemoved: number } {
  const have = Number((db.prepare("SELECT value FROM settings WHERE key='descriptor_version'").get() as { value: string } | undefined)?.value ?? 1);
  if (have >= DESCRIPTOR_VERSION) return { changed: 0, merchantsRemoved: 0 };
  let changed = 0, removed = 0;
  db.transaction(() => {
    const rows = db.prepare("SELECT id, occurred_on, descriptor_raw raw, descriptor_clean clean, review_state rs, kind FROM transactions WHERE status!='void' AND descriptor_raw!=''").all() as any[];
    const upd = db.prepare('UPDATE transactions SET descriptor_clean=?, location_hint=COALESCE(?, location_hint), merchant_id=? WHERE id=?');
    const redo: number[] = [];
    for (const r of rows) {
      const c = cleanDescriptor(r.raw, { year: Number(String(r.occurred_on).slice(0, 4)) });
      if (c.clean === (r.clean ?? '')) continue;
      upd.run(c.clean, c.locationHint, c.clean ? resolveMerchant(db, c.clean, r.raw) : null, r.id);
      changed++;
      if (r.rs === 'needs_category' && !['ignored', 'internal_transfer'].includes(r.kind)) redo.push(r.id);
    }
    for (const id of redo) classify(db, id);
    removed = db.prepare(`DELETE FROM merchants WHERE review_state='unreviewed' AND default_category_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_id=merchants.id) AND NOT EXISTS (SELECT 1 FROM merchant_aliases a WHERE a.merchant_id=merchants.id)
      AND NOT EXISTS (SELECT 1 FROM merchant_group_members g WHERE g.merchant_id=merchants.id)`).run().changes;
    db.prepare("INSERT INTO settings(key, value) VALUES ('descriptor_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(DESCRIPTOR_VERSION));
  })();
  return { changed, merchantsRemoved: removed };
}
