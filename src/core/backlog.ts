import { audit, type DB } from './db.js';
import { suggestionsFor, inboxCounts, inboxItemsByIds, INBOX_WHERE } from './reports.js';
import { createRuleFor, type RuleSpec } from './merchants.js';
import { setSplits } from './transactions.js';

/**
 * Backlog mode (design §8.3): a large import opens a batch review grouped by merchant instead of sending a push per row.
 * One answer applies to every transaction in the group; optionally it also creates a rule you define (with its backtest).
 */
export interface BacklogGroup { key: string; merchantId: number | null; name: string; count: number; totalCents: number; txnIds: number[]; samples: string[]; txns: { id: number; occurred_on: string; amount_cents: number; descriptor_raw: string; account: string }[]; suggestions: { id: number; name: string; why: string }[] }

export function groupedInbox(db: DB): BacklogGroup[] {
  const rows = db.prepare(`SELECT t.id, t.merchant_id mid, COALESCE(m.name, t.descriptor_clean, t.descriptor_raw) name, t.amount_cents a, t.descriptor_raw d, t.decided_rule_id rule, t.occurred_on od, ac.name acct
    FROM transactions t LEFT JOIN merchants m ON m.id=t.merchant_id JOIN accounts ac ON ac.id=t.account_id WHERE t.status!='void' AND t.review_state='needs_category' AND t.kind NOT IN ('ignored','internal_transfer','greenlight_reclass') ORDER BY t.occurred_on DESC`).all() as any[];
  const groups = new Map<string, BacklogGroup & { rule: number | null; desc: string }>();
  for (const r of rows) {
    const key = r.mid ? `m${r.mid}` : `d${String(r.name).toLowerCase()}`;
    const g: BacklogGroup & { rule: number | null; desc: string } = groups.get(key) ?? { key, merchantId: r.mid, name: r.name, count: 0, totalCents: 0, txnIds: [], samples: [], txns: [], suggestions: [], rule: r.rule, desc: r.name };
    g.count++; g.totalCents += r.a; g.txnIds.push(r.id); if (g.txns.length < 200) g.txns.push({ id: r.id, occurred_on: r.od, amount_cents: r.a, descriptor_raw: r.d, account: r.acct }); if (g.samples.length < 3 && !g.samples.includes(r.d)) g.samples.push(r.d);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ rule, desc, ...g }) => ({ ...g, suggestions: suggestionsFor(db, { id: g.txnIds[0], decided_rule_id: rule, descriptor_clean: desc }) })).sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents));
}

export interface BulkResult { applied: number; skipped: number; rule?: ReturnType<typeof createRuleFor> }
/** Apply one category to many transactions (only ones still waiting; a human decision made meanwhile is never overwritten). */
export function bulkAnswer(db: DB, txnIds: number[], categoryId: number, opts: { rule?: RuleSpec; actor?: string } = {}): BulkResult {
  const cat = db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) as { name: string } | undefined;
  if (!cat) throw new Error('unknown category');
  let applied = 0, skipped = 0;
  db.transaction(() => {
    for (const id of txnIds) {
      const t = db.prepare("SELECT amount_cents a, review_state rs, kind, merchant_id m, status FROM transactions WHERE id=?").get(id) as any;
      if (!t || t.rs !== 'needs_category' || t.status === 'void' || ['ignored', 'internal_transfer', 'greenlight_reclass'].includes(t.kind)) { skipped++; continue; }
      setSplits(db, id, [{ categoryId, amountCents: t.a }], 'user'); applied++;
    }
    audit(db, 'backlog', txnIds.length, 'bulk_categorize', undefined, { categoryId, applied, skipped }, opts.actor ?? 'user');
  })();
  const rule = opts.rule && applied ? createRuleFor(db, opts.rule, categoryId, `made while categorizing ${applied} transactions`) : undefined;
  return { applied, skipped, rule };
}


/** `keys`: the merchant groups already on screen, kept in place (and in order) while you work through them, so a card never jumps when its count drops. */
export interface BacklogPageOpts { view: 'merchants' | 'flagged' | 'notes'; limit: number; offset: number; q?: string; today: string; keys?: string[] }
const SHOWN_PER_GROUP = 50;
/**
 * One page of the Backlog. The household can have hundreds of transactions waiting after a big import, so the page only does the expensive
 * work (open reasons, suggestions) for the rows it actually shows: merchants view pages by merchant group, the other tabs page by transaction.
 */
export function backlogPage(db: DB, o: BacklogPageOpts) {
  const counts = inboxCounts(db); const memo = new Map<string, unknown>();
  const like = o.q ? `%${o.q.toLowerCase().slice(0, 80)}%` : null;
  if (o.view === 'merchants') {
    const rows = db.prepare(`SELECT t.id, t.merchant_id mid, COALESCE(m.name, t.descriptor_clean, t.descriptor_raw) name, t.amount_cents a, t.decided_rule_id rule
      FROM transactions t LEFT JOIN merchants m ON m.id=t.merchant_id WHERE t.status!='void' AND t.review_state='needs_category' AND t.kind NOT IN ('ignored','internal_transfer','greenlight_reclass') ORDER BY t.occurred_on DESC, t.id DESC`).all() as any[];
    const groups = new Map<string, { key: string; merchantId: number | null; name: string; count: number; totalCents: number; ids: number[]; rule: number | null }>();
    for (const r of rows) {
      if (like && !String(r.name).toLowerCase().includes(like.slice(1, -1))) continue;
      const key = r.mid ? `m${r.mid}` : `d${String(r.name).toLowerCase()}`;
      const g = groups.get(key) ?? { key, merchantId: r.mid, name: r.name, count: 0, totalCents: 0, ids: [] as number[], rule: r.rule as number | null };
      g.count++; g.totalCents += r.a; g.ids.push(r.id); groups.set(key, g);
    }
    const all = [...groups.values()].sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.name.localeCompare(b.name));
    let shown = all.slice(o.offset, o.offset + o.limit);
    if (o.keys?.length) {
      const byKey = new Map(all.map((g) => [g.key, g]));
      const pinned = o.keys.map((k) => byKey.get(k)).filter((g): g is NonNullable<typeof g> => !!g).slice(0, o.limit);
      const used = new Set(pinned.map((g) => g.key));
      shown = [...pinned, ...all.slice(o.offset).filter((g) => !used.has(g.key)).slice(0, Math.max(0, o.limit - pinned.length))];
    }
    const page = shown.map((g) => {
      const suggestions = suggestionsFor(db, { id: g.ids[0], decided_rule_id: g.rule, descriptor_clean: g.name }, memo);
      const items = inboxItemsByIds(db, g.ids.slice(0, SHOWN_PER_GROUP), o.today, memo, () => suggestions);
      return { key: g.key, merchantId: g.merchantId, name: g.name, count: g.count, totalCents: g.totalCents, suggestions, items, txnIds: g.ids };
    });
    return { view: o.view, total: all.length, totalTxns: all.reduce((a, g) => a + g.count, 0), counts, groups: page, items: [] as ReturnType<typeof inboxItemsByIds> };
  }
  const where = o.view === 'flagged' ? INBOX_WHERE.flagged : INBOX_WHERE.needs_note;
  const filter = like ? ' AND (LOWER(t.descriptor_raw) LIKE ? OR LOWER(COALESCE(t.note,\'\')) LIKE ?)' : '';
  const args: unknown[] = like ? [like, like] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM transactions t WHERE t.status!='void' AND ${where}${filter}`).get(...args) as { c: number }).c;
  const ids = (db.prepare(`SELECT t.id FROM transactions t WHERE t.status!='void' AND ${where}${filter} ORDER BY t.occurred_on DESC, t.id DESC LIMIT ? OFFSET ?`).all(...args, o.limit, o.offset) as { id: number }[]).map((r) => r.id);
  return { view: o.view, total, totalTxns: total, counts, groups: [] as { key: string; merchantId: number | null; name: string; count: number; totalCents: number; suggestions: { id: number; name: string; why: string }[]; items: ReturnType<typeof inboxItemsByIds>; txnIds: number[] }[], items: inboxItemsByIds(db, ids, o.today, memo) };
}
