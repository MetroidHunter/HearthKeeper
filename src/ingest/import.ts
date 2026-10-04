import { audit, type DB } from '../core/db.js';
import { daysBetween } from '../core/time.js';
import { classify, createTransaction } from '../core/transactions.js';
import { applyProfile, layoutSignature, normalizeDescriptor, parseCsv, rowFingerprint, suggestMapping, type ParsedRow, type ProfileSpec } from './csv.js';
import { captureEvent } from './events.js';
import { pairTransfers } from './pairing.js';

export interface ImportPreview { profileId: number | null; signature: string; suggested?: ReturnType<typeof suggestMapping>; total: number; new: number; alreadyImported: number; matchesProvisional: number; errors: { line: number; error: string }[]; willAutoCategorize: number; needsAttention: number }

export function getOrCreateProfile(db: DB, institution: string, rows: string[][], spec?: ProfileSpec): { id: number; spec: ProfileSpec; signature: string } | { id: null; signature: string; suggested: ReturnType<typeof suggestMapping> } {
  const hasHeader = spec ? spec.columnMap.hasHeader : suggestMapping(rows).columnMap.hasHeader;
  const signature = layoutSignature(rows, hasHeader, spec?.skipRows ?? 0);
  const ex = db.prepare('SELECT * FROM import_profiles WHERE header_signature=?').get(signature) as any;
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
export function diffAgainstDb(db: DB, institution: string, rows: ParsedRow[]): { fresh: ParsedRow[]; already: number } {
  const fileCounts = new Map<string, ParsedRow[]>();
  for (const r of rows) { const k = rowFingerprint(institution, r.date, r.amountCents, r.description); (fileCounts.get(k) ?? fileCounts.set(k, []).get(k)!).push(r); }
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

export function previewImport(db: DB, institution: string, csv: string, spec?: ProfileSpec): ImportPreview {
  const rows = parseCsv(csv);
  const prof = getOrCreateProfile(db, institution, rows, spec);
  if (prof.id === null) return { profileId: null, signature: prof.signature, suggested: prof.suggested, total: rows.length, new: 0, alreadyImported: 0, matchesProvisional: 0, errors: [], willAutoCategorize: 0, needsAttention: 0 };
  const parsed = applyProfile(rows, prof.spec);
  const { fresh, already } = diffAgainstDb(db, institution, parsed.rows);
  const accountId = defaultAccount(db, institution);
  const provMatches = fresh.filter((r) => findProvisionalMatch(db, accountId, r)).length;
  return { profileId: prof.id, signature: prof.signature, total: parsed.rows.length, new: fresh.length, alreadyImported: already, matchesProvisional: provMatches, errors: parsed.errors, willAutoCategorize: 0, needsAttention: fresh.length - provMatches };
}

function defaultAccount(db: DB, institution: string, accountId?: number): number {
  if (accountId) return accountId;
  const a = db.prepare('SELECT id FROM accounts WHERE institution=? ORDER BY id LIMIT 1').get(institution) as { id: number } | undefined;
  if (!a) throw new Error(`No account for institution ${institution}`);
  return a.id;
}

export interface ImportResult { imported: number; alreadyImported: number; supersededProvisionals: number; categorized: number; needsCategory: number; errors: { line: number; error: string }[]; transferPairs: number }

export function commitImport(db: DB, institution: string, csv: string, spec?: ProfileSpec, opts: { accountId?: number; filename?: string } = {}): ImportResult {
  const rows = parseCsv(csv);
  const prof = getOrCreateProfile(db, institution, rows, spec);
  if (prof.id === null) throw new Error('No saved mapping for this layout; supply a column mapping (suggested mapping available via preview)');
  const parsed = applyProfile(rows, prof.spec);
  const accountId = defaultAccount(db, institution, opts.accountId);
  const ev = captureEvent(db, { source: institution.toLowerCase().includes('chase') ? 'chase_csv' : 'wf_csv', channel: 'upload', payload: csv, headers: { filename: opts.filename ?? '' } });
  return db.transaction(() => {
    const { fresh, already } = diffAgainstDb(db, institution, parsed.rows);
    let superseded = 0, categorized = 0, needs = 0;
    for (const r of fresh) {
      const kind = r.amountCents >= 0 ? 'income' : 'spending';
      const prov = findProvisionalMatch(db, accountId, r);
      const id = createTransaction(db, { accountId, kind, occurredOn: r.date, postedOn: r.postedOn ?? r.date, amountCents: r.amountCents, descriptor: r.description, fingerprint: rowFingerprint(institution, r.date, r.amountCents, r.description), sourceEventIds: [ev.id] });
      if (prov) { supersedeProvisional(db, prov, id); superseded++; }
      const c = classify(db, id);
      if (c.outcome === 'categorized' || c.outcome === 'internal_transfer' || c.outcome === 'ignored') categorized++; else needs++;
    }
    const pairs = pairTransfers(db);
    db.prepare("UPDATE accounts SET last_synced_at=datetime('now') WHERE id=?").run(accountId);
    audit(db, 'import', prof.id, 'commit', undefined, { institution, imported: fresh.length, already });
    return { imported: fresh.length, alreadyImported: already, supersededProvisionals: superseded, categorized, needsCategory: needs, errors: parsed.errors, transferPairs: pairs.paired };
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

export function findProvisionalMatch(db: DB, accountId: number, r: { date: string; amountCents: number; description: string }, o: MatchOpts = DEFAULT_MATCH): number | null {
  const cands = db.prepare("SELECT id, occurred_on, amount_cents, descriptor_raw, descriptor_clean FROM transactions WHERE account_id=? AND status='provisional' AND superseded_by IS NULL").all(accountId) as any[];
  const scored = cands.filter((c) => Math.abs(daysBetween(c.occurred_on, r.date)) <= o.windowDays && Math.sign(c.amount_cents) === Math.sign(r.amountCents))
    .map((c) => {
      const exact = c.amount_cents === r.amountCents;
      const within = Math.abs(r.amountCents - c.amount_cents) <= Math.abs(c.amount_cents) * o.tolerancePct;
      return { id: c.id as number, exact, within, sim: similarity(c.descriptor_raw, r.description), days: Math.abs(daysBetween(c.occurred_on, r.date)) };
    }).filter((c) => c.sim >= o.minSimilarity && (c.exact || c.within));
  const exacts = scored.filter((s) => s.exact).sort((a, b) => b.sim - a.sim || a.days - b.days);
  if (exacts.length) { if (exacts.length > 1 && exacts[0].sim === exacts[1].sim && exacts[0].days === exacts[1].days) return null; return exacts[0].id; }
  return scored.length === 1 ? scored[0].id : null; // tolerance matches only when exactly one candidate
}

/** The posted record supersedes the provisional one and inherits category, note and flags (phone answers are never lost). */
export function supersedeProvisional(db: DB, provId: number, postedId: number): void {
  const p = db.prepare('SELECT * FROM transactions WHERE id=?').get(provId) as any;
  const posted = db.prepare('SELECT amount_cents FROM transactions WHERE id=?').get(postedId) as any;
  const splits = db.prepare('SELECT category_id, amount_cents, memo, origin FROM transaction_splits WHERE transaction_id=?').all(provId) as any[];
  if (splits.length && p.review_state !== 'needs_category') {
    // Rescale to the posted amount, remainder to the largest split.
    let rest = posted.amount_cents;
    const scaled = splits.map((s, i) => { const v = i === splits.length - 1 ? rest : Math.round((s.amount_cents / p.amount_cents) * posted.amount_cents); rest -= v; return { ...s, amount_cents: v }; });
    db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(postedId);
    const ins = db.prepare('INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,?)');
    for (const s of scaled) ins.run(postedId, s.category_id, s.amount_cents, s.memo, s.origin);
    db.prepare("UPDATE transactions SET review_state=?, decided_by=?, decided_rule_id=? WHERE id=?").run(p.review_state, p.decided_by, p.decided_rule_id, postedId);
  }
  db.prepare('UPDATE transactions SET note=COALESCE(note, ?), note_state=CASE WHEN note IS NULL THEN ? ELSE note_state END, flagged=?, flag_reason=? WHERE id=?').run(p.note, p.note_state, p.flagged, p.flag_reason, postedId);
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
