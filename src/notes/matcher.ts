import type { DB } from '../core/db.js';
import { daysBetween } from '../core/time.js';
import { parseCents } from '../core/money.js';
import { parseCsv } from '../ingest/csv.js';
import { decide, loadRules } from '../core/rules.js';
import { classify, getCategoryId } from '../core/transactions.js';

export type WrapperSource = 'amazon' | 'venmo' | 'paypal' | 'greenlight';

/** Which wrapper source does a bank descriptor name? (source-aware candidate filter, design §10.3 step 1) */
export function wrapperSourceOf(descriptor: string): WrapperSource | null {
  const d = descriptor.toLowerCase();
  if (/venmo/.test(d)) return /cashout|cash out|standard transfer|instant transfer/.test(d) ? null : 'venmo'; // cash-outs are income, not notes (§10.2)
  if (/paypal/.test(d)) return 'paypal';
  if (/amzn|amazon/.test(d)) return 'amazon';
  if (/greenlight app/.test(d)) return 'greenlight'; // money sent to a child's Greenlight card: the bank row does not say which child; the Greenlight message does
  return null;
}
export function ownerHint(descriptor: string): 'brys' | 'miracle' | null {
  const d = descriptor.toLowerCase();
  if (/bunmira|miracle/.test(d)) return 'miracle';
  if (/brys/.test(d)) return 'brys';
  return null;
}

/** Note quality (§10.2): a lone generic emoji is too vague and must be flagged. */
export function noteQuality(note: string): 'sufficient' | 'vague' | 'none' {
  const t = note.trim();
  if (!t) return 'none';
  const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\s]/gu, '');
  if (stripped === '') return [...t.matchAll(/\p{Extended_Pictographic}/gu)].length <= 1 ? 'vague' : 'sufficient';
  return stripped.length < 3 ? 'vague' : 'sufficient';
}

/** Import the skills' `Date,Amount,Note` CSV unchanged; optional columns Source, Account, Counterparty, Ref, Items are used when present (§10.1). */
export function importNotesCsv(db: DB, csv: string, defaultSource: WrapperSource): { imported: number; skippedPhantom: number; duplicates: number } {
  const rows = parseCsv(csv);
  const h = rows[0].map((c) => c.trim().toLowerCase());
  const col = (n: string) => h.indexOf(n);
  let imported = 0, skippedPhantom = 0, duplicates = 0;
  const seenInFile = new Map<string, number>(); // multiset dedupe: identical legit rows within one file are all kept
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const date = normDate(r[col('date')]); if (!date) continue;
      const amount = parseCents(r[col('amount')] || '0');
      const pay = col('payment') >= 0 ? (r[col('payment')] ?? '') : '';
      if (/points|gift ?card|promo/i.test(pay) && !/card|visa|mastercard/i.test(pay)) { skippedPhantom++; continue; } // points-paid phantom rows (§10.2)
      const source = ((col('source') >= 0 && r[col('source')]) || defaultSource).toLowerCase() as WrapperSource;
      const note = (r[col('note')] ?? '').trim();
      const ref = col('ref') >= 0 ? r[col('ref')] : null;
      const cp = col('counterparty') >= 0 ? r[col('counterparty')] : null;
      const key = [source, date, amount, note, ref ?? '', cp ?? ''].join('\u0001');
      const k = seenInFile.get(key) ?? 0; seenInFile.set(key, k + 1);
      const existing = (db.prepare('SELECT COUNT(*) c FROM external_notes WHERE source=? AND occurred_on=? AND amount_cents=? AND note=? AND COALESCE(order_ref,\'\')=COALESCE(?,\'\') AND COALESCE(counterparty,\'\')=COALESCE(?,\'\')').get(source, date, amount, note, ref, cp) as { c: number }).c;
      if (k < existing) { duplicates++; continue; }
      const acct = col('account') >= 0 && r[col('account')] ? (db.prepare('SELECT id FROM accounts WHERE name=? COLLATE NOCASE').get(r[col('account')]) as any)?.id ?? null : null;
      const id = Number(db.prepare('INSERT INTO external_notes(source, account_id, occurred_on, amount_cents, note, counterparty, order_ref) VALUES (?,?,?,?,?,?,?)').run(source, acct, date, amount, note, cp, ref).lastInsertRowid);
      const items = col('items') >= 0 ? r[col('items')] : '';
      if (items) for (const it of items.split(';')) { const [name, qty, price] = it.split('|'); if (name) db.prepare('INSERT INTO external_note_items(external_note_id, name, qty, amount_cents) VALUES (?,?,?,?)').run(id, name.trim(), Number(qty || 1), parseCents(price || '0')); }
      imported++;
    }
  })();
  return { imported, skippedPhantom, duplicates };
}
function normDate(v: string | undefined): string | null {
  if (!v) return null; const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/* ---------- global assignment (Hungarian) ---------- */
const INF = 1e9;
/** Minimum-cost assignment on an n x m cost matrix (n <= m after padding). Returns col index per row or -1 if only INF options. */
export function assign(cost: number[][]): number[] {
  const n = cost.length; if (!n) return [];
  const m = Math.max(cost[0].length, n);
  const a = cost.map((r) => [...r, ...Array(m - r.length).fill(INF)]);
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) { const cur = a[i0 - 1][j - 1] - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] && a[p[j] - 1][j - 1] < INF / 2 && j - 1 < cost[0].length) res[p[j] - 1] = j - 1;
  return res;
}
const total = (cost: number[][], asg: number[]) => asg.reduce((s, j, i) => s + (j >= 0 ? cost[i][j] : 0), 0);

export const WINDOWS: Record<WrapperSource, { before: number; after: number }> = { amazon: { before: 3, after: 3 }, paypal: { before: 3, after: 3 }, venmo: { before: 0, after: 5 }, greenlight: { before: 3, after: 7 } }; // bank date relative to note date

/** Mark wrapper-source charges as awaiting a note (only the three wrapper sources require one by default). */
export function markWrapperNotes(db: DB): number {
  const rows = db.prepare("SELECT id, descriptor_raw, decided_rule_id, review_state FROM transactions WHERE note_state='not_needed' AND status!='void' AND kind IN ('spending','income') AND amount_cents<0 AND COALESCE(note_source,'')!='seed'").all() as any[];
  let n = 0;
  for (const r of rows) {
    const src = wrapperSourceOf(r.descriptor_raw); if (!src) continue;
    // a Greenlight row already settled by a rule (the plan fee, or "$100 → Family Support") needs no note to say which child
    if (src === 'greenlight' && (r.decided_rule_id || r.review_state === 'auto_categorized' || r.review_state === 'user_confirmed')) continue;
    { db.prepare("UPDATE transactions SET note_state='awaiting_note' WHERE id=?").run(r.id); n++; }
  }
  return n;
}

export interface MatchSummary { matched: number; ambiguous: number; needsNote: number }
/** Replaces matchExternalNotes(): source/owner-aware, same sign+amount, per-source windows, global assignment, margin-based confidence. Never overwrites user_provided notes. */
export function runNoteMatcher(db: DB): MatchSummary {
  markWrapperNotes(db);
  const txns = db.prepare("SELECT id, occurred_on, amount_cents, descriptor_raw FROM transactions WHERE note_state IN ('awaiting_note','ambiguous') AND status!='void'").all() as any[];
  const pool = db.prepare('SELECT n.*, a.name account_name FROM external_notes n LEFT JOIN accounts a ON a.id=n.account_id WHERE matched_txn_id IS NULL').all() as any[];
  const feasible = (t: any, n: any): number => {
    const src = wrapperSourceOf(t.descriptor_raw);
    if (!src || n.source !== src || Math.abs(t.amount_cents) !== Math.abs(n.amount_cents)) return INF; // the skills' exports carry the size of the charge (Amazon: "40.85"), while the bank row is negative: compare sizes
    const oh = ownerHint(t.descriptor_raw), no = n.account_name ? ownerHint(n.account_name) : null;
    if (oh && no && oh !== no) return INF;
    const d = daysBetween(n.occurred_on, t.occurred_on); // bank date - note date
    const w = WINDOWS[src];
    if (d < -w.before || d > w.after) return INF;
    return Math.abs(d) + 0.001 + (Math.sign(t.amount_cents) === Math.sign(n.amount_cents) ? 0 : 0.6); // minimize total date distance; when two notes of the same size compete, the one with the same sign clearly wins
  };
  const cost = txns.map((t) => pool.map((n) => feasible(t, n)));
  const out: MatchSummary = { matched: 0, ambiguous: 0, needsNote: 0 };
  if (txns.length && pool.length) {
    const asg = assign(cost);
    for (const [i, j] of asg.entries()) {
      const t = txns[i];
      if (j < 0) continue;
      const best = total(cost, asg);
      const alt = cost.map((r, ri) => ri === i ? r.map((c, cj) => cj === j ? INF : c) : r);
      const asg2 = assign(alt);
      const altTotal = asg2[i] >= 0 ? total(alt, asg2) : Infinity;
      const margin = altTotal - best; // how much worse is the next-best way to assign this transaction
      const note = pool[j];
      const unknown = /^\s*unknown\b/i.test(note.note); // the Amazon skill writes "UNKNOWN - no order number…" when it could not find the order: that is not a note
      const q = unknown ? 'none' : note.source === 'venmo' ? noteQuality(note.note) : note.note ? 'sufficient' : 'none';
      if (margin < 0.5 && isFinite(margin)) {
        db.prepare("UPDATE transactions SET note_state='ambiguous' WHERE id=?").run(t.id); out.ambiguous++; // ambiguity is a state, not text in the note
        continue;
      }
      db.prepare('UPDATE external_notes SET matched_txn_id=? WHERE id=?').run(t.id, note.id);
      if (q !== 'sufficient') { db.prepare("UPDATE transactions SET note_state='needs_note', note=?, flag_reason=? WHERE id=?").run(unknown ? null : note.note || null, unknown ? `${note.source} export could not identify this order` : `vague note (${note.counterparty ?? 'unknown counterparty'})`, t.id); out.needsNote++; }
      else {
        db.prepare("UPDATE transactions SET note=?, note_state='auto_matched', note_source=? WHERE id=?").run(note.note, note.source, t.id); out.matched++;
        // the note is new information: rules that look at the note (e.g. "Greenlight + note contains Marion → Family Support") can now apply
        const cur = db.prepare('SELECT review_state r, kind FROM transactions WHERE id=?').get(t.id) as { r: string; kind: string };
        if (cur.r === 'needs_category' && !['ignored', 'internal_transfer', 'greenlight_reclass'].includes(cur.kind)) classify(db, t.id);
      }
    }
  }
  return out;
}

/** Ranked candidates for an ambiguous/unmatched transaction (one-tap pick in the Inbox). */
export function noteCandidates(db: DB, txnId: number) {
  const t = db.prepare('SELECT id, occurred_on, amount_cents, descriptor_raw FROM transactions WHERE id=?').get(txnId) as any;
  const src = wrapperSourceOf(t.descriptor_raw);
  return (db.prepare('SELECT * FROM external_notes WHERE matched_txn_id IS NULL AND ABS(amount_cents)=ABS(?) AND (? IS NULL OR source=?)').all(t.amount_cents, src, src) as any[])
    .map((n) => ({ ...n, days: Math.abs(daysBetween(n.occurred_on, t.occurred_on)) })).sort((a, b) => a.days - b.days);
}
export function pickNote(db: DB, txnId: number, noteId: number) {
  const n = db.prepare('SELECT * FROM external_notes WHERE id=?').get(noteId) as any;
  db.prepare('UPDATE external_notes SET matched_txn_id=? WHERE id=?').run(txnId, noteId);
  db.prepare("UPDATE transactions SET note=?, note_state='user_provided', note_source=? WHERE id=?").run(n.note, n.source, txnId);
}

/* ---------- item-level splits (§10.5) ---------- */
export interface ItemIn { name: string; qty?: number; cents: number }
export interface SplitProposal { items: { name: string; cents: number; categoryId: number | null; suggestedBy?: string }[]; subsets?: number[][]; status: 'proposed' | 'pick_subset' | 'tick_items' }

/** Allocate tax/shipping proportionally to items so splits sum to the charge; rounding remainder goes to the largest item. */
export function allocateToCharge(items: ItemIn[], chargeCents: number): number[] {
  const sub = items.reduce((a, i) => a + i.cents, 0);
  const out = items.map((i) => Math.round((i.cents * chargeCents) / sub));
  const diff = chargeCents - out.reduce((a, v) => a + v, 0);
  if (diff) out[items.reduce((bi, it, i) => (it.cents > items[bi].cents ? i : bi), 0)] += diff;
  return out;
}

/** Items shipped in one charge: find subsets whose total (plus proportional tax+shipping) equals the charge. Brute force over <=16 items. */
export function findSubsets(items: ItemIn[], orderTotalCents: number, chargeCents: number, limit = 5): number[][] {
  const itemsSum = items.reduce((a, i) => a + i.cents, 0);
  const extras = orderTotalCents - itemsSum; // tax + shipping for the whole order
  const hits: number[][] = [];
  const n = Math.min(items.length, 16);
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0; const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += items[i].cents; idx.push(i); }
    const withExtras = s + Math.round((extras * s) / itemsSum);
    if (Math.abs(withExtras - chargeCents) <= 1) hits.push(idx);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Order total unknown: a subset fits when the charge is its item total plus at most `maxExtraBp` of tax+shipping (or up to 5% under it, for promos). */
export function findSubsetsLoose(items: ItemIn[], chargeCents: number, maxExtraBp = 1500, limit = 5): number[][] {
  const hits: number[][] = [];
  const n = Math.min(items.length, 16);
  for (let mask = 1; mask < 1 << n && hits.length < limit; mask++) {
    let s = 0; const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += items[i].cents; idx.push(i); }
    if (s <= chargeCents + Math.ceil(chargeCents * 0.05) + 1 && chargeCents <= s + Math.ceil((s * maxExtraBp) / 10000) + 1) hits.push(idx);
  }
  return hits;
}

export function proposeItemSplits(db: DB, txnId: number): SplitProposal | null {
  const t = db.prepare('SELECT id, amount_cents FROM transactions WHERE id=?').get(txnId) as any;
  const note = db.prepare('SELECT id FROM external_notes WHERE matched_txn_id=?').get(txnId) as { id: number } | undefined;
  if (!note) return null;
  const items = (db.prepare('SELECT name, qty, amount_cents cents FROM external_note_items WHERE external_note_id=?').all(note.id) as any[]) as ItemIn[];
  if (!items.length) return null;
  const charge = Math.abs(t.amount_cents);
  const itemsSum = items.reduce((a, i) => a + i.cents, 0);
  let chosen = items, status: SplitProposal['status'] = 'proposed', subsets: number[][] | undefined;
  if (itemsSum > charge) { // multi-shipment: the charge covers part of the order
    subsets = findSubsetsLoose(items, charge); // order total unknown: allow tax+shipping up to ~15%
    if (subsets.length === 1) chosen = subsets[0].map((i) => items[i]);
    else { status = subsets.length ? 'pick_subset' : 'tick_items'; return { items: items.map((i) => ({ name: i.name, cents: i.cents, categoryId: null })), subsets, status }; }
  }
  const alloc = allocateToCharge(chosen, charge);
  const rules = loadRules(db);
  return {
    status, subsets,
    items: chosen.map((it, i) => {
      const d = decide(rules, { item_name: it.name, descriptor: it.name, source: 'amazon' });
      const cid = d.rule?.action.category ? getCategoryId(db, d.rule.action.category) : null;
      return { name: it.name, cents: alloc[i] * Math.sign(t.amount_cents), categoryId: cid, suggestedBy: d.rule ? `rule ${d.rule.id}` : undefined };
    }),
  };
}
