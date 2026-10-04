import type { DB } from './db.js';

/** Rules engine (design §9.3). Numeric comparisons are on cents; no string compares of money. */
export type Op = 'contains' | 'word' | 'starts_with' | 'regex' | 'eq' | 'between' | 'in';
export interface Cond { field: string; op: Op; value: unknown }
export interface RuleMatch { all_of: Cond[] }
export interface RuleAction { type: 'categorize' | 'internal_transfer' | 'ignore'; category?: string; reason?: string }
export interface Rule { id: number; enabled: number; priority: number; match: RuleMatch; action: RuleAction; mode: 'auto' | 'suggest' | 'ask'; origin: string }

export interface Candidate {
  descriptor?: string; merchant?: string; merchant_group?: string[]; account?: string; source?: string; amount_cents?: number;
  direction?: 'in' | 'out'; note?: string; counterparty?: string; item_name?: string;
}

function norm(v: unknown): string { return String(v ?? '').toLowerCase(); }
function wordMatch(hay: string, needle: string): boolean {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i').test(hay);
}

export function evalCond(c: Cond, cand: Candidate): boolean {
  let fv: unknown = (cand as Record<string, unknown>)[c.field];
  if (c.field === 'amount_cents') {
    const n = fv as number | undefined;
    if (n === undefined) return false;
    switch (c.op) {
      case 'eq': return n === c.value;
      case 'between': { const [lo, hi] = c.value as [number, number]; return n >= lo && n <= hi; }
      case 'in': return (c.value as number[]).includes(n);
      default: return false;
    }
  }
  if (Array.isArray(fv)) {
    if (c.op === 'in' || c.op === 'eq' || c.op === 'contains') return fv.some((x) => norm(x) === norm(c.value) || (c.op === 'contains' && norm(x).includes(norm(c.value))));
    return false;
  }
  const s = norm(fv);
  switch (c.op) {
    case 'contains': return s.includes(norm(c.value));
    case 'word': return wordMatch(s, norm(c.value));
    case 'starts_with': return s.startsWith(norm(c.value));
    case 'regex': return new RegExp(String(c.value), 'i').test(String(fv ?? ''));
    case 'eq': return s === norm(c.value);
    case 'in': return (c.value as string[]).map(norm).includes(s);
    default: return false;
  }
}

export function ruleMatches(r: Pick<Rule, 'match'>, cand: Candidate): boolean {
  return r.match.all_of.length > 0 && r.match.all_of.every((c) => evalCond(c, cand));
}

export function loadRules(db: DB): Rule[] {
  return (db.prepare('SELECT * FROM rules WHERE enabled=1').all() as any[]).map((r) => ({ ...r, match: JSON.parse(r.match_json), action: JSON.parse(r.action_json) }));
}

export interface Decision { rule: Rule | null; conflicts: Rule[] }
/** Priority (lower number wins) then specificity (more conditions). Same-priority/specificity matches with different actions are a conflict. */
export function decide(rules: Rule[], cand: Candidate): Decision {
  const hits = rules.filter((r) => ruleMatches(r, cand));
  if (!hits.length) return { rule: null, conflicts: [] };
  hits.sort((a, b) => a.priority - b.priority || b.match.all_of.length - a.match.all_of.length || a.id - b.id);
  const top = hits[0];
  const conflicts = hits.slice(1).filter((h) => h.priority === top.priority && h.match.all_of.length === top.match.all_of.length && JSON.stringify(h.action) !== JSON.stringify(top.action));
  return { rule: top, conflicts };
}

export interface Backtest { matched: number; byCategory: Record<string, number> }
/** "This rule would have matched N past transactions; k were X" (§9.3). Uses each past transaction's current category. */
export function backtest(db: DB, rule: Pick<Rule, 'match'>): Backtest {
  const rows = db.prepare(`SELECT t.id, t.descriptor_raw descriptor, t.descriptor_clean, t.amount_cents, t.note, a.name account, m.name merchant,
      (SELECT c.name FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=t.id ORDER BY ABS(s.amount_cents) DESC LIMIT 1) cat
    FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN merchants m ON m.id=t.merchant_id WHERE t.status!='void'`).all() as any[];
  const out: Backtest = { matched: 0, byCategory: {} };
  for (const r of rows) {
    const cand: Candidate = { descriptor: `${r.descriptor} ${r.descriptor_clean ?? ''}`, merchant: r.merchant ?? undefined, account: r.account, amount_cents: r.amount_cents, direction: r.amount_cents < 0 ? 'out' : 'in', note: r.note ?? undefined };
    if (ruleMatches(rule, cand)) { out.matched++; const k = r.cat ?? '(none)'; out.byCategory[k] = (out.byCategory[k] ?? 0) + 1; }
  }
  return out;
}

export function addRule(db: DB, r: { priority?: number; match: RuleMatch; action: RuleAction; mode?: Rule['mode']; origin?: string; notes?: string }): number {
  return Number(db.prepare('INSERT INTO rules(priority, match_json, action_json, mode, origin, notes) VALUES (?,?,?,?,?,?)')
    .run(r.priority ?? 100, JSON.stringify(r.match), JSON.stringify(r.action), r.mode ?? 'suggest', r.origin ?? 'user', r.notes ?? null).lastInsertRowid);
}
