import { describe, it, expect } from 'vitest';
import { openDb } from '../src/core/db.js';
import { parseGuesser, seedFromGuesser } from '../src/seed/guesser.js';
import { seedHousehold as seedAccts, seedCoreRules, seedGreenlightProfiles } from '../src/seed/household.js';
import { addCategory } from '../src/core/categories.js';
import { createTransaction, classify } from '../src/core/transactions.js';

const GS = `
function _guessAtCategory(toCheck, price) {
  switch (true) {
    case toCheck.includes("sephora") || toCheck.includes("ulta"): return "Makeup";
    case toCheck.includes("venmo") && toCheck.includes("brys") && price == '-150': return "Laser Hair";
    case toCheck.includes("arco"): return "Gas";
    case toCheck.includes("chase credit crd"): return "DELETE";
    case toCheck.includes("greenlight app"): return "DELETE";
    case someWeirdFunction(toCheck): return "Weird";
  }
}`;

describe('guesser seeding', () => {
  it('converts includes/&&/||/price cases; flags risky tokens; reports what it cannot read', () => {
    const { cases, unparsed } = parseGuesser(GS);
    expect(cases).toHaveLength(5);
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
