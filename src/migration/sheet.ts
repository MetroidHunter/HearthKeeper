import { DateTime } from 'luxon';
import { audit, type DB } from '../core/db.js';
import { parseCentsExact as parseCents } from '../core/money.js';
import { monthOf, monthIndex } from '../core/time.js';
import { parseCsv } from '../ingest/csv.js';
import { createTransfer } from '../core/transfers.js';
import { setBudget } from '../core/categories.js';

/**
 * Legacy import (design §18). Inputs are CSV exports of the sheet tabs. Column headers are matched by name (case-insensitive) so the exact
 * export layout can vary; the aliases below are the assumed names. Anything missing is reported rather than guessed.
 */
export interface SheetExports { list: string; history: string; budget: string; transactions: string }
export interface MigrationReport {
  droppedHistoryRows: { category: string; stop: string; amountCents: number; reason: string }[];
  categoriesMissingStart: string[];
  categoriesMissingFromList: string[];
  likelyRetiredButUnflagged: string[];
  duplicateBudgetRows: string[];
  strayBudgetRows: string[];
  reallocationRows: { date: string; name: string; category: string; cents: number; kind: 'legacy' | 'adjustment' }[];
  needsCategoryRows: number;
  blankCategoryRows: number;
  legacySplitGroups: { key: string; rows: number; sum: number; splitTotal: number | null; balanced: boolean }[];
  transactionsImported: number;
  legacyLegsImported: number;
  noteFlags: number;
  errors: string[];
}

const ALIASES = {
  list: { name: ['name', 'category'], parent: ['parent', 'group'], start: ['start date', 'start'], deprecated: ['deprecated'] },
  history: { category: ['budget name', 'category', 'name'], amount: ['amount', 'budget', 'old amount', 'previous amount', 'monthly'], stop: ['month stopped using', 'stopped using', 'stop month', 'stop date', 'month stopped'] },
  budget: { parent: ['parent budget', 'parent', 'group'], name: ['budget name', 'name', 'category'], amount: ['budget', 'amount', 'monthly', 'target'], current: ['current'] },
  txn: { date: ['date'], name: ['name', 'description'], category: ['category'], amount: ['charge', 'amount', 'price'], notes: ['notes', 'note'], splitTotal: ['split total'] },
};

function table(csv: string, required: string[][], label: string): { rows: Record<string, string>[]; cols: (keys: string[]) => string | undefined } {
  const all = parseCsv(csv);
  // header = first row that contains all required header groups
  const idx = all.findIndex((r) => required.every((alts) => r.some((c) => alts.includes(c.trim().toLowerCase()))));
  if (idx < 0) throw new Error(`${label}: could not find a header row with columns like ${required.map((a) => a[0]).join(', ')}`);
  const header = all[idx].map((c) => c.trim());
  const rows = all.slice(idx + 1).map((r) => Object.fromEntries(header.map((h, i) => [h.toLowerCase(), (r[i] ?? '').trim()])));
  return { rows, cols: (keys) => keys.find((k) => header.some((h) => h.toLowerCase() === k)) };
}
const get = (r: Record<string, string>, keys: string[]) => { for (const k of keys) if (r[k] !== undefined) return r[k]; return ''; };

export function parseSheetDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  for (const f of ['M/d/yyyy', 'M/d/yy', 'yyyy-MM-dd', 'MMM d, yyyy', 'MMMM d, yyyy']) {
    const d = DateTime.fromFormat(s, f, { zone: 'utc' });
    if (d.isValid) return d.toISODate();
  }
  return null;
}

const REALLOC_RE = /reingest|reignest|zero\s*out|\bingest\b/i;
export const NEEDS_CATEGORY = 'NEEDS CATEGORY';

export function importSheets(db: DB, ex: SheetExports): MigrationReport {
  const rep: MigrationReport = { droppedHistoryRows: [], categoriesMissingStart: [], categoriesMissingFromList: [], likelyRetiredButUnflagged: [], duplicateBudgetRows: [], strayBudgetRows: [], reallocationRows: [], needsCategoryRows: 0, blankCategoryRows: 0, legacySplitGroups: [], transactionsImported: 0, legacyLegsImported: 0, noteFlags: 0, errors: [] };
  const catId = new Map<string, number>();
  const lc = (s: string) => s.trim().toLowerCase();

  db.transaction(() => {
    /* --- categories from List --- */
    const L = table(ex.list, [ALIASES.list.name, ALIASES.list.start], 'List');
    const listed = new Set<string>();
    for (const r of L.rows) {
      const name = get(r, ALIASES.list.name);
      if (!name) continue;
      listed.add(lc(name));
      const start = parseSheetDate(get(r, ALIASES.list.start));
      if (!start) { rep.categoriesMissingStart.push(name); continue; }
      const dep = /^(true|yes|y|1|x|deprecated)$/i.test(get(r, ALIASES.list.deprecated));
      const parent = get(r, ALIASES.list.parent);
      const gid = parent ? Number((db.prepare('INSERT INTO category_groups(name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id').get(parent) as any).id) : null;
      const kind = /^(gig income)$/i.test(name) ? 'income_pool' : /^(salary|hourly income)$/i.test(name) ? 'income_reference' : 'expense';
      const id = Number(db.prepare('INSERT INTO categories(group_id,name,kind,discretionary,start_month,status) VALUES (?,?,?,?,?,?)').run(gid, name, kind, 1, monthOf(start), dep ? 'retired' : 'active').lastInsertRowid);
      catId.set(lc(name), id);
    }

    /* --- budget versions (sheet's own algorithm) --- */
    const B = table(ex.budget, [ALIASES.budget.name, ALIASES.budget.amount], 'Budget');
    const currentAmt = new Map<string, number>();
    for (const r of B.rows) {
      const name = get(r, ALIASES.budget.name);
      const amtRaw = get(r, ALIASES.budget.amount);
      if (!name) continue;
      if (!catId.has(lc(name)) && !listed.has(lc(name))) { rep.strayBudgetRows.push(name); continue; }
      let cents: number;
      try { cents = parseCents(amtRaw === '' ? '0' : amtRaw); } catch { rep.strayBudgetRows.push(name); continue; }
      if (currentAmt.has(lc(name))) rep.duplicateBudgetRows.push(name); // the sheet double-counts duplicates; we keep the first and report
      else currentAmt.set(lc(name), cents);
    }
    const H = table(ex.history, [ALIASES.history.category, ALIASES.history.stop], 'History');
    const hist = new Map<string, { stop: string; cents: number }[]>();
    for (const r of H.rows) {
      const name = get(r, ALIASES.history.category);
      const stop = parseSheetDate(get(r, ALIASES.history.stop));
      if (!name || !stop) continue; // rows with blank category or blank stop month are skipped, as the sheet does
      let cents = 0;
      try { cents = parseCents(get(r, ALIASES.history.amount) || '0'); } catch { rep.errors.push(`History: bad amount for ${name}`); continue; }
      (hist.get(lc(name)) ?? hist.set(lc(name), []).get(lc(name))!).push({ stop: monthOf(stop), cents });
    }
    for (const [key, id] of catId) {
      const cat = db.prepare('SELECT name, start_month FROM categories WHERE id=?').get(id) as { name: string; start_month: string };
      const rows = (hist.get(key) ?? []).sort((a, b) => a.stop.localeCompare(b.stop));
      let boundary = cat.start_month;
      const versions: { month: string; cents: number }[] = [];
      for (const h of rows) {
        // replicate the sheet's silent drop: a row whose stop month <= previous boundary has monthDiff <= 0 and contributes nothing
        if (monthIndex(h.stop) <= monthIndex(boundary)) { rep.droppedHistoryRows.push({ category: cat.name, stop: h.stop, amountCents: h.cents, reason: 'stop month <= previous boundary (sheet silently ignores it)' }); continue; }
        versions.push({ month: boundary, cents: h.cents });
        boundary = h.stop;
      }
      const inBudget = currentAmt.has(key);
      versions.push({ month: boundary, cents: inBudget ? currentAmt.get(key)! : 0 });
      if (!inBudget && rows.length) { /* present in History but absent from Budget: retired, last version (stopN -> 0) already emitted */ }
      if (!inBudget && !rows.length) versions[0] = { month: boundary, cents: 0 };
      for (const v of versions) setBudget(db, id, v.cents, v.month, { reason: 'legacy', actor: 'migration' });
      // retire flag: retired in List, or history exists but no Budget row
      if (!inBudget && rows.length) { db.prepare("UPDATE categories SET status='retired', retired_month=? WHERE id=?").run(boundary, id); }
      if (!inBudget && !rows.length && (db.prepare("SELECT status FROM categories WHERE id=?").get(id) as any).status === 'active') rep.likelyRetiredButUnflagged.push(cat.name);
    }

    /* --- transactions --- */
    const T = table(ex.transactions, [ALIASES.txn.date, ALIASES.txn.amount, ALIASES.txn.name], 'Transactions');
    const acct = db.prepare("SELECT id FROM accounts WHERE name='Legacy'").get() as { id: number } | undefined
      ?? { id: Number(db.prepare("INSERT INTO accounts(name,institution,type,in_system) VALUES ('Legacy','Legacy','bank',0)").run().lastInsertRowid) };
    const groups = new Map<string, { sum: number; n: number; st: number | null }>();
    const ensureCat = (name: string, firstDate: string) => {
      let id = catId.get(lc(name));
      if (id) return id;
      rep.categoriesMissingFromList.push(name);
      id = Number(db.prepare("INSERT INTO categories(name,kind,discretionary,start_month,status) VALUES (?, 'expense', 1, ?, 'retired')").run(name, monthOf(firstDate)).lastInsertRowid);
      catId.set(lc(name), id);
      return id;
    };
    const ins = db.prepare(`INSERT INTO transactions(account_id,kind,status,occurred_on,posted_on,amount_cents,descriptor_raw,descriptor_clean,review_state,decided_by,note,flagged,flag_reason,legacy_group)
      VALUES (?,?, 'posted', ?,?,?,?,?,?, 'user', ?,?,?,?)`);
    const insSplit = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,?)');
    for (const [i, r] of T.rows.entries()) {
      const date = parseSheetDate(get(r, ALIASES.txn.date));
      const name = get(r, ALIASES.txn.name);
      if (!date && !name && !get(r, ALIASES.txn.amount)) continue; // blank line
      let cents: number;
      try { cents = parseCents(get(r, ALIASES.txn.amount)); } catch { rep.errors.push(`Transactions row ${i + 2}: bad amount "${get(r, ALIASES.txn.amount)}"`); continue; }
      if (!date) { rep.errors.push(`Transactions row ${i + 2}: bad date "${get(r, ALIASES.txn.date)}"`); continue; }
      const cat = get(r, ALIASES.txn.category);
      const notes = get(r, ALIASES.txn.notes);
      const flagged = /^\s*(\?\?\?|FLAG:|\?\? AMBIGUOUS)/i.test(notes) ? 1 : 0;
      if (flagged) rep.noteFlags++;
      if (REALLOC_RE.test(name) && cat) {
        const kind = /zero\s*out/i.test(name) ? 'adjustment' : 'legacy';
        const cid = ensureCat(cat, date);
        createTransfer(db, kind, date, [{ categoryId: cid, cents }], notes || name, 'migration', name);
        rep.reallocationRows.push({ date, name, category: cat, cents, kind });
        rep.legacyLegsImported++;
        continue;
      }
      const st = get(r, ALIASES.txn.splitTotal);
      const gkey = st ? `${date}|${name}|${st}` : '';
      let legacyGroup: string | null = null;
      if (gkey) { legacyGroup = gkey; const g = groups.get(gkey) ?? groups.set(gkey, { sum: 0, n: 0, st: parseCents(st) }).get(gkey)!; g.sum += cents; g.n++; }
      const isNeeds = lc(cat) === lc(NEEDS_CATEGORY), isBlank = !cat;
      const cid = isNeeds || isBlank ? null : ensureCat(cat, date);
      if (isNeeds) rep.needsCategoryRows++; if (isBlank) rep.blankCategoryRows++;
      const id = Number(ins.run(acct.id, cents < 0 ? 'spending' : 'income', date, date, cents, name, name.toUpperCase(), cid === null ? 'needs_category' : 'user_confirmed', notes || null, flagged, flagged ? notes : null, legacyGroup).lastInsertRowid);
      insSplit.run(id, cid, cents, cid === null ? `legacy:${isNeeds ? NEEDS_CATEGORY : '(blank)'}` : null, 'legacy');
      rep.transactionsImported++;
    }
    for (const [key, g] of groups) if (g.n > 1) rep.legacySplitGroups.push({ key, rows: g.n, sum: g.sum, splitTotal: g.st, balanced: g.st !== null && Math.abs(g.sum - g.st) <= 0.5 });
    db.prepare("UPDATE categories SET status='retired' WHERE name=? COLLATE NOCASE").run(NEEDS_CATEGORY); // becomes the needs_category state, hidden from pickers
    audit(db, 'migration', 'sheets', 'import', undefined, { tx: rep.transactionsImported, legs: rep.legacyLegsImported }, 'migration');
  })();
  rep.categoriesMissingFromList = [...new Set(rep.categoriesMissingFromList)];
  return rep;
}
