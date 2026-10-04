import type { DB } from '../core/db.js';
import { addRule, type Cond, type RuleAction } from '../core/rules.js';
import { parseCents } from '../core/money.js';

/**
 * One-time conversion of IFTTT_guess.gs into rules (design §9.7).
 * Expected shape (inferred from the design; the source file was not available when this was written, so verify against the real file):
 *
 *   switch (true) {
 *     case toCheck.includes("sephora") || toCheck.includes("ulta"): return "Makeup";
 *     case toCheck.includes("venmo") && toCheck.includes("brys") && price == '-150': return "Laser Hair";
 *     case toCheck.includes("greenlight app"): return "DELETE";
 *   }
 *
 * Source order becomes priority. Anything the parser cannot read is reported verbatim, never dropped silently.
 */
export interface SeedReport { rules: number; riskyTokens: string[]; unparsed: string[]; internalTransferRules: number; unknownCategories: string[]; deprecatedCategories: string[] }

const RISKY = new Set(['arco', 'ulta', 'orca', 'm2m', '76 -', 'target', 'shell', 'amc', 'cvs', 'ace', 'bp']);

export interface ParsedCase { priority: number; clauses: Cond[][]; result: string; source: string }

export function parseGuesser(src: string): { cases: ParsedCase[]; unparsed: string[] } {
  const cases: ParsedCase[] = [], unparsed: string[] = [];
  const re = /case\s+([^:]+?):\s*(?:\/\/[^\n]*\n\s*)?return\s+(['"`])(.*?)\2\s*;?/gs;
  let m: RegExpExecArray | null, order = 0;
  const seen: string[] = [];
  while ((m = re.exec(src))) {
    const expr = m[1].trim(), result = m[3];
    seen.push(m[0]);
    const ors = expr.split(/\s*\|\|\s*/);
    const clauses: Cond[][] = [];
    let ok = true;
    for (const o of ors) {
      const ands = o.split(/\s*&&\s*/);
      const conds: Cond[] = [];
      for (const a of ands) {
        let mm: RegExpExecArray | null;
        if ((mm = /^\(?\s*toCheck\.includes\(\s*(['"`])(.*?)\1\s*\)\s*\)?$/.exec(a.trim()))) conds.push({ field: 'descriptor', op: RISKY.has(mm[2].toLowerCase()) || mm[2].length <= 4 ? 'word' : 'contains', value: mm[2] });
        else if ((mm = /^price\s*(?:==|===)\s*(['"`]?)(-?[\d.,]+)\1$/.exec(a.trim()))) conds.push({ field: 'amount_cents', op: 'eq', value: parseCents(mm[2]) }); // numeric compare, not string
        else if ((mm = /^\(?\s*!\s*toCheck\.includes/.exec(a.trim()))) { ok = false; }
        else ok = false;
      }
      clauses.push(conds);
    }
    if (ok) cases.push({ priority: 100 + order++, clauses, result, source: m[0].trim() });
    else unparsed.push(m[0].trim());
  }
  // case statements the regex did not consume at all
  for (const line of src.split('\n')) if (/^\s*case\s/.test(line) && !seen.some((s) => s.includes(line.trim()))) unparsed.push(line.trim());
  return { cases, unparsed: [...new Set(unparsed)] };
}

export function seedFromGuesser(db: DB, src: string): SeedReport {
  const { cases, unparsed } = parseGuesser(src);
  const rep: SeedReport = { rules: 0, riskyTokens: [], unparsed, internalTransferRules: 0, unknownCategories: [], deprecatedCategories: [] };
  const cat = (n: string) => db.prepare('SELECT id, status FROM categories WHERE name=? COLLATE NOCASE').get(n) as { id: number; status: string } | undefined;
  db.transaction(() => {
    for (const c of cases) {
      let action: RuleAction;
      if (/greenlight app/i.test(c.source)) { continue; } // handled by the Greenlight engine (§11.2)
      if (/^DELETE$/i.test(c.result)) { action = { type: 'internal_transfer', reason: 'legacy DELETE rule' }; rep.internalTransferRules++; }
      else {
        action = { type: 'categorize', category: c.result };
        const k = cat(c.result);
        if (!k) rep.unknownCategories.push(c.result); else if (k.status === 'retired') rep.deprecatedCategories.push(c.result);
      }
      for (const conds of c.clauses) {
        for (const x of conds) if (x.op === 'word') rep.riskyTokens.push(String(x.value));
        addRule(db, { priority: c.priority, match: { all_of: conds }, action, mode: action.type === 'internal_transfer' ? 'auto' : 'suggest', origin: 'legacy_guesser', notes: `was: ${c.source.slice(0, 200)}` });
        rep.rules++;
      }
    }
  })();
  rep.riskyTokens = [...new Set(rep.riskyTokens)]; rep.unknownCategories = [...new Set(rep.unknownCategories)]; rep.deprecatedCategories = [...new Set(rep.deprecatedCategories)];
  return rep;
}
