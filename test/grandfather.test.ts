import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { grandfatherSeed, SEED_LABEL } from '../src/migration/grandfather.js';
import { inbox } from '../src/core/reports.js';
import { markWrapperNotes } from '../src/notes/matcher.js';
import { addRule } from '../src/core/rules.js';
import { unretireCategory } from '../src/core/categories.js';
import { buildApp } from '../src/server/app.js';

/** Rows shaped exactly like the sheet importer writes them: split origin 'legacy', a null category when the sheet had none. */
function legacy(h: ReturnType<typeof seedHousehold>, descriptor: string, cents: number, categoryId: number | null, memo: string | null = null) {
  const id = createTransaction(h.db, { accountId: h.chase, occurredOn: '2025-03-04', amountCents: cents, descriptor });
  h.db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(id);
  h.db.prepare("INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,?,?,?,'legacy')").run(id, categoryId, cents, memo);
  h.db.prepare("UPDATE transactions SET review_state=? WHERE id=?").run(categoryId === null ? 'needs_category' : 'user_confirmed', id);
  return id;
}

describe('seed history is valid as it stands (D58)', () => {
  it('moves uncategorized imported rows to a reserved category, notes wrapper payments, and clears them from the inbox', () => {
    const h = seedHousehold();
    const parked = legacy(h, 'MYSTERY STORE', -1200, null, 'legacy:NEEDS CATEGORY');
    const amazon = legacy(h, 'AMAZON MKTPLACE PMTS', -2399, h.cats['Groceries']);
    const fine = legacy(h, 'SAFEWAY', -500, h.cats['Groceries']);
    const mine = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -700, descriptor: 'NEW AFTER SEED' }); // not imported: untouched
    expect(inbox(h.db).counts.needsCategory).toBe(2);
    const r = grandfatherSeed(h.db);
    expect(r).toMatchObject({ categorized: 1, noted: 1 });
    const t = (id: number) => h.db.prepare('SELECT review_state, note, note_state, note_source, decided_by FROM transactions WHERE id=?').get(id) as any;
    expect(t(parked)).toMatchObject({ review_state: 'user_confirmed', decided_by: 'seed' });
    expect(t(amazon)).toMatchObject({ note: SEED_LABEL, note_state: 'not_needed' });
    expect(t(fine).note).toBeNull();
    expect(t(mine)).toMatchObject({ review_state: 'needs_category', note_source: null });
    const cat = h.db.prepare("SELECT id, system, status, kind FROM categories WHERE name=?").get(SEED_LABEL) as any;
    expect(cat).toMatchObject({ system: 1, status: 'retired', kind: 'income_reference' });
    expect((h.db.prepare('SELECT category_id FROM transaction_splits WHERE transaction_id=?').get(parked) as any).category_id).toBe(cat.id);
    expect(inbox(h.db).counts.needsCategory).toBe(1); // only the post-seed one
  });
  it('is idempotent, and does nothing on a database with no imported rows', () => {
    const h = seedHousehold();
    expect(grandfatherSeed(h.db)).toMatchObject({ skipped: 'no_legacy_rows' });
    legacy(h, 'X', -100, null);
    expect(grandfatherSeed(h.db).categorized).toBe(1);
    expect(grandfatherSeed(h.db)).toMatchObject({ skipped: 'already_done' });
  });
  it('the note matcher never re-flags imported wrapper payments as needing notes', () => {
    const h = seedHousehold();
    legacy(h, 'AMAZON MKTPLACE PMTS', -2399, h.cats['Groceries']);
    grandfatherSeed(h.db);
    markWrapperNotes(h.db);
    expect(inbox(h.db).counts.needsNote).toBe(0);
    const fresh = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -1500, descriptor: 'AMAZON MKTPLACE PMTS' });
    markWrapperNotes(h.db);
    expect((h.db.prepare('SELECT note_state FROM transactions WHERE id=?').get(fresh) as any).note_state).toBe('awaiting_note'); // new ones still need notes
  });
  it('the reserved category cannot be chosen, used in a rule, or unretired, but an already-assigned row can be re-saved', async () => {
    const h = seedHousehold();
    const parked = legacy(h, 'MYSTERY', -300, null, 'legacy:(blank)');
    grandfatherSeed(h.db);
    const sys = (h.db.prepare('SELECT id FROM categories WHERE name=?').get(SEED_LABEL) as any).id;
    const other = createTransaction(h.db, { accountId: h.chase, occurredOn: '2026-10-05', amountCents: -100, descriptor: 'OTHER' });
    expect(() => setSplits(h.db, other, [{ categoryId: sys, amountCents: -100 }])).toThrow(/reserved/);
    expect(() => addRule(h.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'x' }] }, action: { type: 'categorize', category: SEED_LABEL } })).toThrow(/reserved/);
    expect(() => unretireCategory(h.db, sys, '2026-10')).toThrow(/reserved/);
    expect(() => setSplits(h.db, parked, [{ categoryId: sys, amountCents: -300 }])).not.toThrow();
    const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    const r = await app.inject({ method: 'POST', url: `/api/transactions/${other}/categorize`, headers: { 'x-requested-with': 'hearthkeeper' }, payload: { categoryId: sys } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const cats = (await app.inject({ url: '/api/categories' })).json();
    expect(cats.find((c: any) => c.name === SEED_LABEL).system).toBe(1); // exposed with the flag so the UI can hide it
  });
});
