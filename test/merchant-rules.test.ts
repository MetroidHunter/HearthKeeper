import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, classify, setSplits } from '../src/core/transactions.js';
import { suggestionsFor } from '../src/core/reports.js';
import { addRule, ruleMatches, decide, loadRules } from '../src/core/rules.js';
import { merchantHistory } from '../src/core/merchants.js';
import { answerCategory } from '../src/core/answers.js';
import { backlogPage } from '../src/core/backlog.js';
import { MIGRATIONS } from '../src/core/schema.js';

function setup() {
  const h = seedHousehold();
  const mk = (d: string, c = -1000, on = '2026-10-01') => { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: on, amountCents: c, descriptor: d }); classify(h.db, id); return id; };
  return { h, mk };
}

describe('merchant history is the merchant rule', () => {
  it('counts only your own answers, most-chosen first, and tolerates exceptions', () => {
    const { h, mk } = setup();
    const ids = [1, 2, 3, 4].map(() => mk('SQ *CORNER BAKERY SEATTLE WA'));
    for (const id of ids.slice(0, 3)) answerCategory(h.db, id, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }]);
    answerCategory(h.db, ids[3], [{ categoryId: h.cats['Groceries'], amountCents: -1000 }]); // a one-off
    const mid = (h.db.prepare('SELECT merchant_id m FROM transactions WHERE id=?').get(ids[0]) as any).m;
    expect(merchantHistory(h.db, mid).map((x) => [x.name, x.n])).toEqual([['Eating Out', 3], ['Groceries', 1]]);
    const next = mk('SQ *CORNER BAKERY SEATTLE WA', -1000, '2026-10-02');
    const s = suggestionsFor(h.db, { id: next, decided_rule_id: null, descriptor_clean: 'CORNER BAKERY' });
    expect(s[0]).toMatchObject({ name: 'Eating Out', why: 'merchant history' });
    expect((h.db.prepare('SELECT review_state r FROM transactions WHERE id=?').get(next) as any).r).toBe('needs_category'); // merchants only ever suggest
  });
  it('a rule is offered first and the merchant guess is offered alongside it', () => {
    const { h, mk } = setup();
    const a = mk('SQ *CORNER BAKERY SEATTLE WA');
    answerCategory(h.db, a, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }]);
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'bakery' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'suggest' });
    const b = mk('SQ *CORNER BAKERY SEATTLE WA', -1000, '2026-10-02');
    const t = h.db.prepare('SELECT decided_rule_id r FROM transactions WHERE id=?').get(b) as any;
    const s = suggestionsFor(h.db, { id: b, decided_rule_id: t.r, descriptor_clean: 'CORNER BAKERY' });
    expect(s.slice(0, 2).map((x) => [x.name, x.why])).toEqual([['Groceries', 'rule'], ['Eating Out', 'merchant history']]);
  });
  it('an auto rule beats whatever the merchant history says', () => {
    const { h, mk } = setup();
    const a = mk('SQ *CORNER BAKERY SEATTLE WA');
    answerCategory(h.db, a, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }]);
    addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'bakery' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' });
    const b = mk('SQ *CORNER BAKERY SEATTLE WA', -1000, '2026-10-02');
    expect((h.db.prepare('SELECT s.category_id c FROM transaction_splits s WHERE s.transaction_id=?').get(b) as any).c).toBe(h.cats['Groceries']);
  });
  it('a rule made while categorizing is yours (not learned) and returns its backtest', () => {
    const { h, mk } = setup();
    const a = mk('SQ *CORNER BAKERY SEATTLE WA');
    const r = answerCategory(h.db, a, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }], { rule: { match: { all_of: [{ field: 'merchant', op: 'eq', value: 'CORNER BAKERY' }] }, mode: 'auto', priority: 40 } });
    expect(r.rule!.backtest.matched).toBe(1);
    expect(h.db.prepare('SELECT origin, mode, priority FROM rules WHERE id=?').get(r.rule!.id)).toEqual({ origin: 'user', mode: 'auto', priority: 40 });
    expect(() => answerCategory(h.db, a, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }], { rule: { match: { all_of: [{ field: 'merchant', op: 'eq', value: '  ' }] } } })).toThrow(/value/);
    answerCategory(h.db, a, [{ categoryId: h.cats['Eating Out'], amountCents: -1000 }]); // answering without a rule never creates one
    expect((h.db.prepare("SELECT COUNT(*) c FROM rules WHERE origin='learned'").get() as any).c).toBe(0);
  });
});

describe('AND / OR conditions', () => {
  const cand = { descriptor: 'AMZN Mktp US*2K4 pet supplies', merchant: 'AMAZON', account: 'Chase' };
  const m = (all_of: any[]) => ({ match: { all_of } });
  it('ANDs clauses and ORs the alternatives inside a clause', () => {
    expect(ruleMatches(m([{ field: 'merchant', op: 'eq', value: 'amazon' }, { field: 'descriptor', op: 'contains', value: 'pet' }]), cand)).toBe(true);
    expect(ruleMatches(m([{ field: 'merchant', op: 'eq', value: 'amazon' }, { field: 'descriptor', op: 'contains', value: 'garden' }]), cand)).toBe(false);
    const or = { any_of: [{ field: 'descriptor', op: 'contains', value: 'garden' }, { field: 'descriptor', op: 'contains', value: 'pet' }] };
    expect(ruleMatches(m([{ field: 'merchant', op: 'eq', value: 'amazon' }, or]), cand)).toBe(true);
    expect(ruleMatches(m([or]), { descriptor: 'something else' })).toBe(false);
    expect(ruleMatches(m([{ any_of: [] }]), cand)).toBe(false);
  });
  it('is stored, applied and validated through the rules API path', () => {
    const { h, mk } = setup();
    addRule(h.db, { match: { all_of: [{ field: 'account', op: 'eq', value: (h.db.prepare('SELECT name FROM accounts WHERE id=?').get(h.chase) as any).name }, { any_of: [{ field: 'descriptor', op: 'contains', value: 'shell' }, { field: 'descriptor', op: 'contains', value: 'chevron' }] }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' });
    const a = mk('CHEVRON 0042'), b = mk('SHELL OIL 7'), c = mk('MYSTERY');
    const cat = (id: number) => (h.db.prepare('SELECT category_id c FROM transaction_splits WHERE transaction_id=?').get(id) as any)?.c ?? null;
    expect([cat(a), cat(b)]).toEqual([h.cats['Groceries'], h.cats['Groceries']]);
    expect(cat(c)).toBeNull();
    expect(decide(loadRules(h.db), { descriptor: 'chevron', account: (h.db.prepare('SELECT name FROM accounts WHERE id=?').get(h.chase) as any).name }).rule).not.toBeNull();
    expect(() => addRule(h.db, { match: { all_of: [{ any_of: [{ field: 'descriptor', op: 'contains', value: '' }] }] }, action: { type: 'categorize', category: 'Groceries' } })).toThrow(/value/);
    expect(() => addRule(h.db, { match: { all_of: [] }, action: { type: 'categorize', category: 'Groceries' } })).toThrow();
  });
});

describe('amount conditions', () => {
  const rule = (c: any) => ({ match: { all_of: [c] } });
  it('amount_abs compares the size whichever way the money moves; amount_cents stays signed', () => {
    const out = { amount_cents: -2500, direction: 'out' as const }, inn = { amount_cents: 2500, direction: 'in' as const };
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'eq', value: 2500 }), out)).toBe(true);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'eq', value: 2500 }), inn)).toBe(true);
    expect(ruleMatches(rule({ field: 'amount_cents', op: 'eq', value: 2500 }), out)).toBe(false);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'gte', value: 2500 }), out)).toBe(true);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'gte', value: 2501 }), out)).toBe(false);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'lte', value: 2500 }), inn)).toBe(true);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'between', value: [2000, 3000] }), out)).toBe(true);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'between', value: [2600, 3000] }), out)).toBe(false);
    expect(ruleMatches({ match: { all_of: [{ field: 'amount_abs', op: 'gte', value: 1000 }, { field: 'direction', op: 'eq', value: 'in' }] } }, out)).toBe(false);
    expect(ruleMatches(rule({ field: 'amount_abs', op: 'eq', value: 1 }), {})).toBe(false);
  });
  it('rejects amounts that cannot work', () => {
    const { h } = setup(); const act = { type: 'categorize' as const, category: 'Groceries' };
    for (const value of [[3000, 2000], [1], 'abc', NaN, -5]) expect(() => addRule(h.db, { match: { all_of: [{ field: 'amount_abs', op: Array.isArray(value) ? 'between' : 'eq', value } as any] }, action: act })).toThrow();
    expect(() => addRule(h.db, { match: { all_of: [{ field: 'amount_abs', op: 'between', value: [2000, 3000] }] }, action: act })).not.toThrow();
  });
});

describe('backlog keeps merchant cards in place', () => {
  it('pinned keys keep their order even when counts change', () => {
    const { h, mk } = setup();
    for (let i = 0; i < 3; i++) mk('SQ *ALPHA CAFE SEATTLE WA', -500 - i);
    for (let i = 0; i < 2; i++) mk('SQ *BETA DELI SEATTLE WA', -700 - i);
    const first = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, today: '2026-10-07' });
    const keys = first.groups.map((g) => g.key);
    expect(first.groups.map((g) => g.count)).toEqual([...first.groups.map((g) => g.count)].sort((a, b) => b - a));
    // answer rows of the biggest merchant until it has fewer than the next one
    const top = first.groups[0];
    for (const id of top.txnIds.slice(0, top.count - 1)) answerCategory(h.db, id, [{ categoryId: h.cats['Groceries'], amountCents: (h.db.prepare('SELECT amount_cents a FROM transactions WHERE id=?').get(id) as any).a }]);
    const unpinned = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, today: '2026-10-07' });
    expect(unpinned.groups[0].key).not.toBe(keys[0]); // by count it would jump below
    const pinned = backlogPage(h.db, { view: 'merchants', limit: 10, offset: 0, today: '2026-10-07', keys });
    expect(pinned.groups.map((g) => g.key)).toEqual(keys); // it stays put
  });
});

describe('migration: merchant rules are retired', () => {
  it('keeps auto choices as your rules and drops learned suggestions', () => {
    const { h } = setup();
    h.db.prepare("INSERT INTO rules(match_json, action_json, mode, origin) VALUES ('{\"all_of\":[{\"field\":\"merchant\",\"op\":\"eq\",\"value\":\"A\"}]}', '{\"type\":\"categorize\",\"category\":\"Groceries\"}', 'suggest', 'learned')").run();
    h.db.prepare("INSERT INTO rules(match_json, action_json, mode, origin) VALUES ('{\"all_of\":[{\"field\":\"merchant\",\"op\":\"eq\",\"value\":\"B\"}]}', '{\"type\":\"categorize\",\"category\":\"Groceries\"}', 'auto', 'learned')").run();
    h.db.exec(MIGRATIONS[MIGRATIONS.length - 1]);
    const rows = h.db.prepare("SELECT origin, mode FROM rules WHERE notes IS NULL OR notes NOT LIKE 'was the%'").all() as any[];
    expect(rows.filter((r) => r.origin === 'learned')).toHaveLength(0);
    expect(rows.filter((r) => r.mode === 'auto' && r.origin === 'user').length).toBeGreaterThanOrEqual(1);
  });
});
