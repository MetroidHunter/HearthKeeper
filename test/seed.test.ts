import { describe, it, expect } from 'vitest';
import { openDb } from '../src/core/db.js';
import { parseGuesser, seedFromGuesser } from '../src/seed/guesser.js';
import { seedHousehold as seedAccts, seedCoreRules, seedGreenlightProfiles } from '../src/seed/household.js';
import { addCategory } from '../src/core/categories.js';
import { createTransaction, classify } from '../src/core/transactions.js';

const GS = `
function _guessAtCategory(toCheck, price) {
  switch (true) {
    case toCheck.includes("sephora"):
    case toCheck.includes("ulta"):
      return "Makeup";
    case toCheck.includes("venmo") && toCheck.includes("brys") && price == '-150':
      return "Laser Hair";
    case toCheck.includes("arco"):
      return "Gas";
    case toCheck.includes("chase credit crd"):
      return "DELETE";
    case toCheck.includes("greenlight app"):
      return "DELETE";
    case someWeirdFunction(toCheck):
      return "Weird";
    default:
      return null;
  }
}`;

describe('guesser seeding', () => {
  it('converts includes/&&/||/price cases; flags risky tokens; reports what it cannot read', () => {
    const { cases, unparsed } = parseGuesser(GS);
    expect(cases).toHaveLength(6); // sephora, ulta, venmo, arco, chase, greenlight app
    expect(unparsed.join('\n')).toContain('someWeirdFunction');
    const db = openDb();
    for (const n of ['Makeup', 'Laser Hair', 'Gas']) addCategory(db, { name: n, startMonth: '2020-01' });
    const rep = seedFromGuesser(db, GS);
    expect(rep.rules).toBe(5); // sephora, ulta, venmo, arco, chase; greenlight app is left to the engine
    expect(rep.riskyTokens).toEqual(expect.arrayContaining(['ulta', 'arco']));
    expect(rep.internalTransferRules).toBe(1);
    const a = Object.assign(seedAccts(db), {});
    const acct = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as any).id;
    const t1 = createTransaction(db, { accountId: acct, occurredOn: '2026-01-01', amountCents: -15000, descriptor: 'VENMO PAYMENT BRYS' });
    const t2 = createTransaction(db, { accountId: acct, occurredOn: '2026-01-01', amountCents: -15001, descriptor: 'VENMO PAYMENT BRYS' });
    const t3 = createTransaction(db, { accountId: acct, occurredOn: '2026-01-01', amountCents: -500, descriptor: "MARCO'S PIZZA" });
    expect(classify(db, t1).outcome).toBe('suggested');
    expect(classify(db, t2).outcome).toBe('needs_category');
    expect(classify(db, t3).outcome).toBe('needs_category'); // arco must not match Marco's
    expect(Object.keys(a.tokens)).toEqual(['greenlight-device', 'receiver-mailbox']);
  });
  it('household seed is idempotent and creates profiles only when categories exist', () => {
    const db = openDb();
    seedAccts(db); expect(Object.keys(seedAccts(db).tokens)).toEqual([]);
    seedCoreRules(db); seedCoreRules(db);
    expect((db.prepare('SELECT COUNT(*) c FROM rules').get() as any).c).toBe(5);
    expect(seedGreenlightProfiles(db)).toEqual(['Miracle Spending', 'Family Support']);
    addCategory(db, { name: 'Miracle Spending', startMonth: '2020-01' }); addCategory(db, { name: 'Family Support', startMonth: '2020-01' });
    expect(seedGreenlightProfiles(db)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) c FROM greenlight_profiles').get() as any).c).toBe(2);
  });
});

import { readFileSync } from 'node:fs';
describe('real IFTTT_Guess.gs', () => {
  const src = readFileSync(new URL('../docs/legacy-scripts/IFTTT_Guess.gs', import.meta.url), 'utf8');
  const caseLines = src.split('\n').filter((l) => /^\s*case\s/.test(l)).length;
  it('parses every case line of the real file with nothing unparsed', () => {
    const { cases, unparsed } = parseGuesser(src);
    expect(unparsed).toEqual([]);
    expect(cases).toHaveLength(caseLines);
    expect(cases.map((c) => c.priority)).toEqual(cases.map((_, i) => 100 + i)); // file order preserved exactly
  });
  it('seeds rules that reproduce the original guesser on representative inputs', () => {
    const db = openDb();
    seedAccts(db);
    const rep = seedFromGuesser(db, src);
    expect(rep.unparsed).toEqual([]);
    expect(rep.riskyTokens).toEqual(expect.arrayContaining(['arco', 'ulta', 'orca', 'm2m', '76 -']));
    expect(rep.skippedGreenlight).toBe(1);
    expect(rep.fragile.some((f) => f.startsWith('Miracle Life Insurance'))).toBe(true);
    const acct = (db.prepare('SELECT id FROM accounts LIMIT 1').get() as any).id;
    const guess = (desc: string, cents = -1000) => {
      for (const c of new Set(rep.categoriesUsed)) if (!db.prepare('SELECT 1 FROM categories WHERE name=?').get(c)) addCategory(db, { name: c, startMonth: '2020-01' });
      const id = createTransaction(db, { accountId: acct, occurredOn: '2026-01-01', amountCents: cents, descriptor: desc });
      const r = classify(db, id);
      if (r.outcome === 'internal_transfer') return 'DELETE';
      if (r.outcome === 'needs_category' && !r.ruleId) return null;
      return r.ruleId ? (JSON.parse((db.prepare('SELECT action_json a FROM rules WHERE id=?').get(r.ruleId) as any).a).category as string) : null;
    };
    expect(guess('SHELL OIL 574216 SEATTLE WA')).toBe('Gas');
    expect(guess("MARCO'S PIZZA")).toBeNull();              // arco must not match inside Marco's
    expect(guess('CONSULTANT FEES')).toBeNull();            // ulta must not match inside consultant
    expect(guess('SEPHORA #182')).toBe('Makeup');
    expect(guess('STARBUCKS #55 SEATTLE')).toBe('Eating Out');
    expect(guess('VENMO PAYMENT BRYS SEPULVEDA', -15000)).toBe('Laser Hair');
    expect(guess('VENMO PAYMENT BRYS SEPULVEDA', -15001)).not.toBe('Laser Hair'); // numeric compare: exact amount only
    expect(guess('VENMO PAYMENT', -30000)).toBe('Schouvi');
    expect(guess('PAYMENT THANK YOU - WEB', 5000)).toBe('DELETE');
    expect(guess('STATE FARM RO 27 SFPP 1234 19')).toBe('Miracle Life Insurance');
    expect(guess('STATE FARM RO 27 SFPP 1234 15')).toBe('Car Insurance');
  });
});
