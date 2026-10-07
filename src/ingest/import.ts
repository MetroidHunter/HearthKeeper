import { audit, type DB } from '../core/db.js';
import { daysBetween } from '../core/time.js';
import { classify, createTransaction } from '../core/transactions.js';
import { applyProfile, layoutSignature, normalizeDescriptor, parseCsv, rowFingerprint, suggestMapping, type ParsedRow, type ProfileSpec } from './csv.js';
import { captureEvent } from './events.js';
import { pairTransfers } from './pairing.js';
import { runNoteMatcher } from '../notes/matcher.js';

export interface ImportPreview { profileId: number | null; signature: string; suggested?: ReturnType<typeof suggestMapping>; total: number; new: number; alreadyImported: number; matchesProvisional: number; errors: { line: number; error: string }[]; willAutoCategorize: number; needsAttention: number }

export function getOrCreateProfile(db: DB, institution: string, rows: string[][], spec?: ProfileSpec): { id: number; spec: ProfileSpec; signature: string } | { id: null; signature: string; suggested: ReturnType<typeof suggestMapping> } {
  const hasHeader = spec ? spec.columnMap.hasHeader : suggestMapping(rows).columnMap.hasHeader;
  const signature = `${institution}:${layoutSignature(rows, hasHeader, spec?.skipRows ?? 0)}`; // scoped: two institutions can share a headerless column count
  const ex = db.prepare('SELECT * FROM import_profiles WHERE header_signature=?').get(signature) as any;
  if (ex && spec) { // an explicit mapping is a correction: it replaces the saved one
    db.prepare('UPDATE import_profiles SET column_map_json=?, date_format=?, sign_rule=?, skip_rows=? WHERE id=?').run(JSON.stringify(spec.columnMap), spec.dateFormat, spec.signRule, spec.skipRows, ex.id);
    return { id: ex.id, signature, spec };
  }
  if (ex) return { id: ex.id, signature, spec: { columnMap: JSON.parse(ex.column_map_json), dateFormat: ex.date_format, signRule: ex.sign_rule, skipRows: ex.skip_rows } };
  if (!spec) return { id: null, signature, suggested: suggestMapping(rows) };
  const id = Number(db.prepare('INSERT INTO import_profiles(name, institution, header_signature, column_map_json, date_format, sign_rule, skip_rows) VALUES (?,?,?,?,?,?,?)')
    .run(`${institution} ${signature}`, institution, signature, JSON.stringify(spec.columnMap), spec.dateFormat, spec.signRule, spec.skipRows).lastInsertRowid);
  return { id, signature, spec };
}

/**
 * Overlap-safe de-dup as a multiset difference (design §8.3): if the DB already holds N rows with a fingerprint and the file has M >= N, import M - N.
 * Scope is the institution, not the account (D35).
 */
export function importScope(institution: string, accountId?: number): string { return accountId ? `${institution}#${accountId}` : institution; }

/** `scope` is the institution (default, D35) or `institution#accountId` when the caller names the account, so an identical fee on a second account is not mistaken for a re-import. */
export function diffAgainstDb(db: DB, scope: string, rows: ParsedRow[]): { fresh: ParsedRow[]; already: number } {
  const fileCounts = new Map<string, ParsedRow[]>();
  for (const r of rows) { const k = rowFingerprint(scope, r.date, r.amountCents, r.description); (fileCounts.get(k) ?? fileCounts.set(k, []).get(k)!).push(r); }
  const fresh: ParsedRow[] = []; let already = 0;
  for (const [k, list] of fileCounts) {
    const have = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE fingerprint=? AND status!='void'").get(k) as { c: number }).c;
    const skip = Math.min(have, list.length);
    already += skip;
    fresh.push(...list.slice(skip));
  }
  fresh.sort((a, b) => a.line - b.line);
  return { fresh, already };
}

export function previewImport(db: DB, institution: string, csv: string, spec?: ProfileSpec, opts: { accountId?: number } = {}): ImportPreview {
  const rows = parseCsv(csv);
  const prof = getOrCreateProfile(db, institution, rows, spec);
  if (prof.id === null) return { profileId: null, signature: prof.signature, suggested: prof.suggested, total: rows.length, new: 0, alreadyImported: 0, matchesProvisional: 0, errors: [], willAutoCategorize: 0, needsAttention: 0 };
  const parsed = applyProfile(rows, prof.spec);
  const { fresh, already } = diffAgainstDb(db, importScope(institution, opts.accountId), parsed.rows);
  const accountId = defaultAccount(db, institution, opts.accountId);
  const provMatches = assignProvisionals(db, accountId, fresh).size;
  return { profileId: prof.id, signature: prof.signature, total: parsed.rows.length, new: fresh.length, alreadyImported: already, matchesProvisional: provMatches, errors: parsed.errors, willAutoCategorize: 0, needsAttention: fresh.length - provMatches };
}

function defaultAccount(db: DB, institution: string, accountId?: number): number {
  if (accountId) return accountId;
  const a = db.prepare('SELECT id FROM accounts WHERE institution=? ORDER BY id LIMIT 1').get(institution) as { id: number } | undefined;
  if (!a) throw new Error(`No account for institution ${institution}`);
  return a.id;
}

export interface ImportResult { imported: number; alreadyImported: number; supersededProvisionals: number; categorized: number; needsCategory: number; errors: { line: number; error: string }[]; transferPairs: number; waitingOnNotes: number; notesMatched: number }

export function commitImport(db: DB, institution: string, csv: string, spec?: ProfileSpec, opts: { accountId?: number; filename?: string } = {}): ImportResult {
  const rows = parseCsv(csv);
  const prof = getOrCreateProfile(db, institution, rows, spec);
  if (prof.id === null) throw new Error('No saved mapping for this layout; supply a column mapping (suggested mapping available via preview)');
  const parsed = applyProfile(rows, prof.spec);
  const accountId = defaultAccount(db, institution, opts.accountId);
  const ev = captureEvent(db, { source: institution.toLowerCase().includes('chase') ? 'chase_csv' : 'wf_csv', channel: 'upload', payload: csv, headers: { filename: opts.filename ?? '' } });
  return db.transaction(() => {
    const scope = importScope(institution, opts.accountId);
    const { fresh, already } = diffAgainstDb(db, scope, parsed.rows);
    const provFor = assignProvisionals(db, accountId, fresh); // exact matches first, then unique tolerance matches over what is left
    let superseded = 0, categorized = 0, needs = 0;
    for (const r of fresh) {
      const kind = r.amountCents >= 0 ? 'income' : 'spending';
      const prov = provFor.get(r) ?? null;
      const id = createTransaction(db, { accountId, kind, occurredOn: r.date, postedOn: r.postedOn ?? r.date, amountCents: r.amountCents, descriptor: r.description, fingerprint: rowFingerprint(scope, r.date, r.amountCents, r.description), sourceEventIds: [ev.id] });
      if (prov) { supersedeProvisional(db, prov, id); superseded++; }
      const c = classify(db, id);
      if (c.outcome === 'categorized' || c.outcome === 'internal_transfer' || c.outcome === 'ignored') categorized++; else needs++;
    }
    const pairs = pairTransfers(db);
    db.prepare("UPDATE accounts SET last_synced_at=datetime('now') WHERE id=?").run(accountId);
    audit(db, 'import', prof.id, 'commit', undefined, { institution, imported: fresh.length, already });
    // Amazon / Venmo / PayPal charges need a note: flag them now (and match any notes already received), not whenever the 10-minute timer next runs
    const nm = runNoteMatcher(db);
    const waitingOnNotes = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE account_id=? AND status!='void' AND note_state IN ('awaiting_note','needs_note','ambiguous')").get(accountId) as { c: number }).c;
    return { imported: fresh.length, alreadyImported: already, supersededProvisionals: superseded, categorized, needsCategory: needs, errors: parsed.errors, transferPairs: pairs.paired, waitingOnNotes, notesMatched: nm.matched };
  })();
}

/* ---------- provisional -> posted (design §8.6) ---------- */
const tokens = (s: string) => new Set(normalizeDescriptor(s).split(' ').filter((t) => t.length > 2));
function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}
export interface MatchOpts { tolerancePct: number; windowDays: number; minSimilarity: number }
export const DEFAULT_MATCH: MatchOpts = { tolerancePct: 0.25, windowDays: 5, minSimilarity: 0.5 };

interface Cand { id: number; exact: boolean; within: boolean; sim: number; days: number }
function candidatesFor(provs: any[], r: { date: string; amountCents: number; description: string }, o: MatchOpts, taken: Set<number>): Cand[] {
  return provs.filter((c) => !taken.has(c.id) && Math.abs(daysBetween(c.occurred_on, r.date)) <= o.windowDays && Math.sign(c.amount_cents) === Math.sign(r.amountCents))
    .map((c) => ({ id: c.id as number, exact: c.amount_cents === r.amountCents, within: Math.abs(r.amountCents - c.amount_cents) <= Math.abs(c.amount_cents) * o.tolerancePct, sim: similarity(c.descriptor_raw, r.description), days: Math.abs(daysBetween(c.occurred_on, r.date)) }))
    .filter((c) => c.sim >= o.minSimilarity && (c.exact || c.within));
}
/** Pending (provisional) and stale rows are both candidates: a posted row that arrives after the stale threshold must still supersede its alert, or the spend counts twice. */
const openProvisionals = (db: DB, accountId: number) => db.prepare("SELECT id, occurred_on, amount_cents, descriptor_raw FROM transactions WHERE account_id=? AND status IN ('provisional','stale') AND superseded_by IS NULL AND greenlight_ref IS NULL").all(accountId) as any[];

/**
 * Assign posted rows to provisionals one-to-one (design §8.6). Pass 1: exact amounts only, so a tolerance match can never steal the provisional an exact row
 * further down the file should get. Pass 2: tolerance matches, only when the candidate is unique. Ambiguous ties stay unmatched.
 */
export function assignProvisionals(db: DB, accountId: number, rows: ParsedRow[], o: MatchOpts = DEFAULT_MATCH): Map<ParsedRow, number> {
  const provs = openProvisionals(db, accountId); const taken = new Set<number>(); const out = new Map<ParsedRow, number>();
  if (!provs.length) return out;
  for (const r of rows) { // pass 1
    const ex = candidatesFor(provs, r, o, taken).filter((c) => c.exact).sort((a, b) => b.sim - a.sim || a.days - b.days);
    if (!ex.length || (ex.length > 1 && ex[0].sim === ex[1].sim && ex[0].days === ex[1].days)) continue;
    out.set(r, ex[0].id); taken.add(ex[0].id);
  }
  for (const r of rows) { // pass 2
    if (out.has(r)) continue;
    const cs = candidatesFor(provs, r, o, taken);
    if (cs.length === 1) { out.set(r, cs[0].id); taken.add(cs[0].id); }
  }
  return out;
}

export function findProvisionalMatch(db: DB, accountId: number, r: { date: string; amountCents: number; description: string }, o: MatchOpts = DEFAULT_MATCH): number | null {
  return assignProvisionals(db, accountId, [r as ParsedRow], o).get(r as ParsedRow) ?? null;
}

/** The posted record supersedes the provisional one and inherits category, note and flags (phone answers are never lost). */
export function supersedeProvisional(db: DB, provId: number, postedId: number): void {
  const p = db.prepare('SELECT * FROM transactions WHERE id=?').get(provId) as any;
  const posted = db.prepare('SELECT amount_cents FROM transactions WHERE id=?').get(postedId) as any;
  const splits = db.prepare('SELECT category_id, amount_cents, memo, origin FROM transaction_splits WHERE transaction_id=?').all(provId) as any[];
  // A charge you hid because it never posted is real spending once the bank does post it: that hide must not carry over. (A transfer, or a row hidden for another reason, does carry over.)
  const hiddenAsNeverPosted = p.kind === 'ignored' && p.ignored_reason === 'pending charge never posted';
  if (!hiddenAsNeverPosted && (p.kind === 'internal_transfer' || p.kind === 'ignored')) {
    // the alert was already a paired transfer / hidden row: the posted row must be the same thing, in the same pairing group
    db.prepare("UPDATE transactions SET kind=?, ignored_reason=?, transfer_group=?, review_state='not_needed', decided_by=?, decided_rule_id=? WHERE id=?").run(p.kind, p.ignored_reason, p.transfer_group, p.decided_by, p.decided_rule_id, postedId);
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(postedId);
  } else if (splits.length && p.review_state !== 'needs_category') {
    // rescale to the posted amount (tips), remainder to the last split
    let rest = posted.amount_cents;
    const scaled = splits.map((s, i) => { const v = i === splits.length - 1 ? rest : Math.round((s.amount_cents / p.amount_cents) * posted.amount_cents); rest -= v; return { ...s, amount_cents: v }; });
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(postedId);
    const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,?)');
    for (const s of scaled) ins.run(postedId, s.category_id, s.amount_cents, s.memo, s.origin);
    db.prepare("UPDATE transactions SET review_state=?, decided_by=?, decided_rule_id=? WHERE id=?").run(p.review_state, p.decided_by, p.decided_rule_id, postedId);
  }
  db.prepare('UPDATE transactions SET owner_user_id=COALESCE(owner_user_id, ?), note=COALESCE(note, ?), note_state=CASE WHEN note IS NULL THEN ? ELSE note_state END, note_source=COALESCE(note_source, ?), flagged=?, flag_reason=? WHERE id=?')
    .run(p.owner_user_id, p.note, p.note_state, p.note_source, p.flagged, p.flag_reason, postedId);
  db.prepare('UPDATE external_notes SET matched_txn_id=? WHERE matched_txn_id=?').run(postedId, provId); // the note found for the alert now belongs to the posted row
  db.prepare("UPDATE transactions SET status='void', superseded_by=? WHERE id=?").run(postedId, provId);
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(provId);
}

/** Provisionals with no posted match after N days become stale and show up in the Inbox. */
export function markStale(db: DB, today: string, days = 7): number {
  const rows = db.prepare("SELECT id, occurred_on FROM transactions WHERE status='provisional' AND superseded_by IS NULL AND greenlight_ref IS NULL").all() as any[];
  let n = 0;
  for (const r of rows) if (daysBetween(r.occurred_on, today) > days) { db.prepare("UPDATE transactions SET status='stale' WHERE id=?").run(r.id); n++; }
  return n;
}

/** Coverage per institution: last transaction date, last upload, stale badge (design §8.3). */
export function coverage(db: DB, today: string, staleDays = 7) {
  return (db.prepare(`SELECT a.institution, MAX(t.occurred_on) last_txn, MAX(a.last_synced_at) last_upload FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.status!='void'
      WHERE a.in_system=1 AND a.type IN ('credit_card','bank') GROUP BY a.institution`).all() as any[]).map((r) => ({ ...r, stale: !r.last_txn || daysBetween(r.last_txn, today) > staleDays }));
}
