import type { DB } from '../core/db.js';
import { addRule, type Cond, type RuleAction } from '../core/rules.js';
import { parseCents } from '../core/money.js';

/**
 * One-time conversion of IFTTT_Guess.gs into rules (design §9.7). The real file is a `switch (true)` of fall-through cases:
 *
 *   case toCheck.includes("shell oil"):
 *   case toCheck.includes("arco"):
 *     return "Gas";
 *   case toCheck.includes("venmo") && toCheck.includes("brys") && price == '-150':
 *   case toCheck.includes("ellis"):
 *     return "Laser Hair";
 *
 * Every `case` line becomes one rule. First-match-wins in the original, so each case line gets its own ascending priority
 * (file order is preserved exactly). Anything the parser cannot read is reported verbatim, never dropped silently.
 */
export interface SeedReport {
  rules: number; riskyTokens: string[]; fragile: string[]; unparsed: string[]; internalTransferRules: number;
  skippedGreenlight: number; unknownCategories: string[]; deprecatedCategories: string[]; categoriesUsed: string[];
}

/** Tokens too short or too common to match as bare substrings: `arco` is inside "Marco's", `ulta` inside "consultant" (§3.3 #3). */
const RISKY = new Set(['arco', 'ulta', 'orca', 'm2m', '76 -', 'qfc', 'aclu', 'hulu', 'ellis', 'quantum', 'subway', 'lyft', 'canva', 'capcut', 'bird app', 'twitch', 'ace', 'bp']);

export interface ParsedCase { index: number; priority: number; conds: Cond[]; result: string; source: string; fragile: string[] }

function parseCond(a: string, fragile: string[]): Cond | null {
  let mm: RegExpExecArray | null;
  if ((mm = /^toCheck\.includes\(\s*(['"`])(.*?)\1\s*\)$/.exec(a))) {
    const v = mm[2];
    const word = RISKY.has(v.toLowerCase()) || /^[a-z0-9]{1,4}$/i.test(v);
    // a bare number inside a longer token (State Farm's "19"/"15") is a known-fragile legacy rule; flagged for the review report
    if (/^\d+$/.test(v)) fragile.push(v);
    return { field: 'descriptor', op: word ? 'word' : 'contains', value: v };
  }
  if ((mm = /^price\s*(?:==|===)\s*(['"`]?)(-?[\d.,]+)\1$/.exec(a))) return { field: 'amount_cents', op: 'eq', value: parseCents(mm[2]) }; // numeric compare, not a string compare
  return null;
}

export function parseGuesser(src: string): { cases: ParsedCase[]; unparsed: string[]; defaultReturn: string | null } {
  const cases: ParsedCase[] = [], unparsed: string[] = [];
  let pending: { expr: string; line: string }[] = [];
  let defaultReturn: string | null = null, index = 0, inDefault = false;
  for (const raw of src.split('\n')) {
    const line = raw.trim().replace(/\/\/.*$/, '').trim();
    let m: RegExpExecArray | null;
    if ((m = /^case\s+(.+?)\s*:$/.exec(line))) { pending.push({ expr: m[1], line }); continue; }
    if (/^default\s*:$/.test(line)) { inDefault = true; continue; }
    if ((m = /^return\s+(?:(['"`])(.*?)\1|null)\s*;?$/.exec(line))) {
      if (inDefault) { defaultReturn = m[2] ?? null; inDefault = false; pending = []; continue; }
      for (const p of pending) {
        const fragile: string[] = [];
        const parts = p.expr.split(/\s*&&\s*/);
        const conds = parts.map((x) => parseCond(x.trim(), fragile));
        if (conds.some((c) => c === null) || m[2] === undefined) unparsed.push(p.line);
        else cases.push({ index, priority: 100 + index, conds: conds as Cond[], result: m[2], source: `${p.line} return "${m[2]}"`, fragile });
        index++;
      }
      pending = [];
    }
  }
  for (const p of pending) unparsed.push(p.line); // dangling cases with no return
  return { cases, unparsed, defaultReturn };
}

export function seedFromGuesser(db: DB, src: string): SeedReport {
  const { cases, unparsed } = parseGuesser(src);
  const rep: SeedReport = { rules: 0, riskyTokens: [], fragile: [], unparsed, internalTransferRules: 0, skippedGreenlight: 0, unknownCategories: [], deprecatedCategories: [], categoriesUsed: [] };
  const cat = (n: string) => db.prepare('SELECT id, status FROM categories WHERE name=? COLLATE NOCASE').get(n) as { id: number; status: string } | undefined;
  db.transaction(() => {
    for (const c of cases) {
      if (c.conds.some((x) => x.field === 'descriptor' && String(x.value).toLowerCase() === 'greenlight app')) { rep.skippedGreenlight++; continue; } // handled by the Greenlight engine (§11.2)
      let action: RuleAction;
      if (/^DELETE$/i.test(c.result)) { action = { type: 'internal_transfer', reason: 'legacy DELETE rule' }; rep.internalTransferRules++; }
      else {
        action = { type: 'categorize', category: c.result };
        rep.categoriesUsed.push(c.result);
        const k = cat(c.result);
        if (!k) rep.unknownCategories.push(c.result); else if (k.status === 'retired') rep.deprecatedCategories.push(c.result);
      }
      for (const x of c.conds) if (x.op === 'word') rep.riskyTokens.push(String(x.value));
      rep.fragile.push(...c.fragile.map((f) => `${c.result}: bare "${f}"`));
      addRule(db, { priority: c.priority, match: { all_of: c.conds }, action, mode: action.type === 'internal_transfer' ? 'auto' : 'suggest', origin: 'legacy_guesser', notes: `was: ${c.source.slice(0, 200)}` });
      rep.rules++;
    }
  })();
  const uniq = (a: string[]) => [...new Set(a)];
  rep.riskyTokens = uniq(rep.riskyTokens); rep.unknownCategories = uniq(rep.unknownCategories); rep.deprecatedCategories = uniq(rep.deprecatedCategories); rep.categoriesUsed = uniq(rep.categoriesUsed); rep.fragile = uniq(rep.fragile);
  return rep;
}
