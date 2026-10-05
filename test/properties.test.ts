import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { categoryBalance, checkInvariants } from '../src/core/balance.js';
import { setBudget, retireCategory } from '../src/core/categories.js';
import { createTransaction, setSplits, classify } from '../src/core/transactions.js';
import { createTransfer, proposeRebalance, commitRebalance, placePool, adjustment } from '../src/core/transfers.js';
import { processGreenlightMessage, attributionViolations } from '../src/greenlight/engine.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { addRule } from '../src/core/rules.js';

/** Seeded PRNG so every failure is reproducible from its seed. */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

describe('property: conservation of money (design §7.8, §17.5)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random operations keep invariants and the envelope identity (seed ${seed})`, () => {
      const r = rng(seed); const h = seedHousehold(); const db = h.db;
      const names = Object.keys(h.cats); const ids = Object.values(h.cats);
      const asOf = '2026-12-31';
      const identity = () => {
        // Σ category balances == Σ accrued + Σ split amounts + Σ unbalanced transfer legs (balanced transfers cancel exactly)
        const bal = ids.reduce((a, id) => a + (categoryBalance(db, id, asOf).total ?? categoryBalance(db, id, asOf).splits + categoryBalance(db, id, asOf).transfers + categoryBalance(db, id, asOf).accrued), 0);
        const acc = ids.reduce((a, id) => a + categoryBalance(db, id, asOf).accrued, 0);
        const splits = (db.prepare("SELECT COALESCE(SUM(s.amount_cents),0) v FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id WHERE t.status!='void' AND s.category_id IS NOT NULL").get() as any).v;
        const unbalanced = (db.prepare("SELECT COALESCE(SUM(l.amount_cents),0) v FROM envelope_transfer_legs l JOIN envelope_transfers e ON e.id=l.transfer_id WHERE e.kind IN ('adjustment','legacy')").get() as any).v;
        expect(bal).toBe(acc + splits + unbalanced);
      };
      for (let step = 0; step < 30; step++) {
        const date = `2026-${String(int(r, 3, 11)).padStart(2, '0')}-${String(int(r, 1, 27)).padStart(2, '0')}`;
        const op = int(r, 0, 7);
        if (op <= 2) { // spending split across 1-3 categories, whole cents
          const total = -int(r, 100, 90000); const n = int(r, 1, 3); const cats = Array.from({ length: n }, () => pick(r, ids));
          const parts: number[] = []; let left = total; for (let i = 0; i < n - 1; i++) { const p = Math.trunc(total / n); parts.push(p); left -= p; } parts.push(left);
          const t = createTransaction(db, { accountId: h.chase, occurredOn: date, amountCents: total, descriptor: `M${int(r, 1, 9)}` });
          setSplits(db, t, parts.map((p, i) => ({ categoryId: cats[i], amountCents: p })));
        } else if (op === 3) { const t = createTransaction(db, { accountId: h.wf, kind: 'income', occurredOn: date, amountCents: int(r, 1000, 500000), descriptor: 'PAY' }); setSplits(db, t, [{ categoryId: h.cats['Gig Income'], amountCents: (db.prepare('SELECT amount_cents a FROM transactions WHERE id=?').get(t) as any).a }]); }
        else if (op === 4) { const a = pick(r, ids), b = pick(r, ids); if (a !== b) { const c = int(r, 1, 50000); createTransfer(db, 'manual', date, [{ categoryId: a, cents: -c }, { categoryId: b, cents: c }]); } }
        else if (op === 5) { commitRebalance(db, proposeRebalance(db, date)); }
        else if (op === 6) { const pool = categoryBalance(db, h.cats['Gig Income'], date).total ?? 0; if (pool > 100) placePool(db, date, h.cats['Gig Income'], [{ categoryId: pick(r, ids.filter((i) => i !== h.cats['Gig Income'])), cents: int(r, 1, pool) }]); }
        else { if (r() < 0.5) adjustment(db, date, pick(r, ids), -int(r, 1, 10000), 'fuzz'); else setBudget(db, pick(r, ids.filter((i) => i !== h.cats['Salary'])), int(r, 0, 200000), `2026-${String(int(r, 3, 11)).padStart(2, '0')}`); }
        expect(checkInvariants(db), `seed ${seed} step ${step} op ${op}`).toEqual([]);
      }
      identity();
      // retiring a category moves its balance in one transfer and preserves the identity
      retireCategory(db, h.cats['Manicure'], '2026-12', { moveBalanceTo: h.cats['Groceries'], asOf });
      expect(categoryBalance(db, h.cats['Manicure'], asOf).total).toBe(0);
      expect(checkInvariants(db)).toEqual([]);
      void names;
    });
  }
});

describe('property: Greenlight attribution (design §11.8 #3)', () => {
  const TEMPLATES = [
    (p: string, c: number) => `$${(c / 100).toFixed(2)} allowance transferred to ${p}`,
    (p: string, c: number) => `${p} spent $${(c / 100).toFixed(2)} at TST* VENDOR ${c % 7} SEATTLE WA`,
    (p: string, c: number) => `${p}'s final purchase amount of $${(c / 100).toFixed(2)} at TST* VENDOR ${c % 7} SEATTLE WA has posted.`,
    (p: string, c: number) => `↔️ ${p} moved $${(c / 100).toFixed(2)} from Spend Anywhere to your Wallet. Tap to view details.`,
    (p: string, c: number) => `${p} withdrew $${(c / 100).toFixed(2)} from Some Store.`,
    (p: string, c: number) => `${p} requests $${(c / 100).toFixed(2)} to buy something`,
    (p: string, c: number) => `${p}'s $${(c / 100).toFixed(2)} purchase at SOME PLACE was declined.`,
    (p: string, c: number) => `${p} is scheduled to receive $${Math.round(c / 100)} allowance tomorrow morning. We'll send it.`,
  ];
  for (let seed = 1; seed <= 25; seed++) {
    it(`no event for one profile ever touches the other's category; funding never charges (seed ${seed})`, () => {
      const r = rng(1000 + seed); const h = seedHousehold(); const db = h.db;
      addRule(db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'vendor 3' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
      addRule(db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'greenlight app' }] }, action: { type: 'internal_transfer', reason: 'greenlight_funding' }, mode: 'auto' });
      const owner = new Map<number, string>();
      for (let i = 1; i <= 60; i++) {
        const p = r() < 0.5 ? 'Miracle' : 'Marion'; const c = int(r, 100, 20000);
        const day = `October ${int(r, 1, 28)}, 2026`;
        const out = processGreenlightMessage(db, i, `${pick(r, TEMPLATES)(p, c)} on ${day} at 0${int(r, 1, 9)}:15PM`, '2026-10-29T00:00:00Z');
        if ('txnId' in out && out.txnId) owner.set(out.txnId, p);
        if (r() < 0.15) { const f = createTransaction(db, { accountId: h.wf, occurredOn: '2026-10-05', amountCents: -int(r, 500, 20000), descriptor: 'GREENLIGHT APP 261005 GREENLIGHT BRYS' }); classify(db, f); }
      }
      const myCat = { Miracle: h.cats['Miracle Spending'], Marion: h.cats['Family Support'] } as Record<string, number>;
      const other = { Miracle: h.cats['Family Support'], Marion: h.cats['Miracle Spending'] } as Record<string, number>;
      for (const [txn, p] of owner) for (const s of db.prepare('SELECT category_id FROM transaction_splits WHERE transaction_id=?').all(txn) as any[]) expect(s.category_id, `txn ${txn} of ${p}`).not.toBe(other[p]);
      void myCat;
      expect(attributionViolations(db)).toEqual([]);
      expect(checkInvariants(db)).toEqual([]);
      // under option A funding never charges a category
      expect(db.prepare("SELECT COUNT(*) c FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE UPPER(t.descriptor_raw) LIKE 'GREENLIGHT APP%'").get()).toEqual({ c: 0 });
      // Marion's spends never create a ledger effect at all
      expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE kind='greenlight_reclass' AND greenlight_ref LIKE 'spend:2:%'").get()).toEqual({ c: 0 });
    });
  }
});

describe('property: imports are idempotent and never change a human decision (design §2.3, §17.5)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`shuffled overlapping re-imports converge to exactly the file's rows (seed ${seed})`, () => {
      const r = rng(5000 + seed); const h = seedHousehold(); const db = h.db;
      const vendors = ['COFFEE A', 'COFFEE B', 'GROCER 1', 'GAS 7', 'BOOKS'];
      const rows = Array.from({ length: 40 }, () => ({ d: `10/${String(int(r, 1, 20)).padStart(2, '0')}/2026`, v: pick(r, vendors), a: -(int(r, 1, 6) * 250) })); // many collisions on purpose
      const csv = (xs: typeof rows) => 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' + xs.map((x) => `${x.d},${x.d},${x.v},Misc,Sale,${(x.a / 100).toFixed(2)},`).join('\n') + '\n';
      const m = suggestMapping(parseCsv(csv(rows))); const spec = { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 };
      const sorted = [...rows].sort((a, b) => a.d.localeCompare(b.d));
      // import overlapping windows of the same sorted file, in random order, several times
      const windows = [[0, 25], [10, 40], [0, 40], [20, 40], [5, 30]].map(([a, b]) => sorted.slice(a, b));
      for (let k = 0; k < 6; k++) commitImport(db, 'Chase', csv(pick(r, windows)), spec);
      commitImport(db, 'Chase', csv(sorted), spec);
      expect((db.prepare("SELECT COUNT(*) c FROM transactions WHERE status!='void'").get() as any).c).toBe(rows.length);
      // a human answer survives re-imports and re-classification
      const first = db.prepare('SELECT id, amount_cents FROM transactions ORDER BY id LIMIT 1').get() as any;
      setSplits(db, first.id, [{ categoryId: h.cats['Groceries'], amountCents: first.amount_cents }], 'user');
      addRule(db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'coffee' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
      commitImport(db, 'Chase', csv(sorted), spec);
      for (const t of db.prepare("SELECT id FROM transactions WHERE status!='void'").all() as any[]) classify(db, t.id);
      expect((db.prepare('SELECT category_id c FROM transaction_splits WHERE transaction_id=?').get(first.id) as any).c).toBe(h.cats['Groceries']);
      expect(checkInvariants(db)).toEqual([]);
    });
  }
});
