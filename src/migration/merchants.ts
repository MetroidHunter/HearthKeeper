import type { DB } from '../core/db.js';
import { cleanDescriptor } from '../core/descriptor.js';

/**
 * Bootstrap merchants from history (design §18.2): clean every historical descriptor, cluster by cleaned name, link transactions,
 * and propose merges for the review page. Creates `unreviewed` merchants only; it never sets default categories (history books restaurants to
 * personal buckets like "Brys Spending", which would make poor future suggestions).
 */
export interface MerchantBootstrap { merchantsCreated: number; transactionsLinked: number; mergeSuggestions: { names: string[]; transactions: number }[] }

export function bootstrapMerchants(db: DB): MerchantBootstrap {
  const rows = db.prepare("SELECT id, descriptor_raw d FROM transactions WHERE merchant_id IS NULL AND descriptor_raw != '' AND status != 'void'").all() as { id: number; d: string }[];
  const byName = new Map<string, number>((db.prepare('SELECT id, name FROM merchants').all() as { id: number; name: string }[]).map((m) => [m.name.toLowerCase(), m.id]));
  const counts = new Map<string, number>();
  let created = 0, linked = 0;
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO merchants(name, review_state) VALUES (?, 'unreviewed')");
    const upd = db.prepare('UPDATE transactions SET merchant_id=?, descriptor_clean=?, location_hint=COALESCE(location_hint, ?) WHERE id=?');
    for (const r of rows) {
      const c = cleanDescriptor(r.d);
      if (!c.clean) continue;
      let id = byName.get(c.clean.toLowerCase());
      if (!id) { id = Number(ins.run(c.clean).lastInsertRowid); byName.set(c.clean.toLowerCase(), id); created++; }
      upd.run(id, c.clean, c.locationHint, r.id); linked++;
      counts.set(c.clean, (counts.get(c.clean) ?? 0) + 1);
    }
  })();
  // merge suggestions: names sharing their first two words (e.g. "SEPHORA" / "SEPHORA.COM" / "SEPHORA INSIDE KOHLS" share the first word)
  const groups = new Map<string, string[]>();
  for (const name of counts.keys()) {
    const toks = name.split(' '); const key = toks[0].length >= 5 ? toks[0].replace(/\.COM$/, '') : toks.slice(0, 2).join(' ');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(name);
  }
  const mergeSuggestions = [...groups.values()].filter((g) => g.length > 1).map((names) => ({ names: names.sort((a, b) => (counts.get(b)! - counts.get(a)!)), transactions: names.reduce((a, n) => a + counts.get(n)!, 0) }))
    .sort((a, b) => b.transactions - a.transactions).slice(0, 100);
  return { merchantsCreated: created, transactionsLinked: linked, mergeSuggestions };
}
