import { describe, it, expect } from 'vitest';
import { seedHousehold } from './helpers.js';
import { monthsOverview } from '../src/core/months.js';
import { budgetPage, inbox } from '../src/core/reports.js';
import { checkInvariants } from '../src/core/balance.js';

// Guards the hot paths against index regressions: the real sheet has ~17.6k transactions and the old close checklist once took 5.5s there
// because transaction_splits had no index on transaction_id.
describe('performance at real-history scale (20k transactions)', () => {
  const h = seedHousehold();
  const cats = Object.values(h.cats);
  h.db.transaction(() => {
    const ins = h.db.prepare("INSERT INTO transactions(account_id, kind, occurred_on, amount_cents, descriptor_raw, review_state) VALUES (?, 'spending', ?, ?, ?, 'user_confirmed')");
    const sp = h.db.prepare('INSERT INTO transaction_splits(transaction_id, category_id, amount_cents) VALUES (?,?,?)');
    for (let i = 0; i < 20000; i++) {
      const d = `20${20 + (i % 6)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
      const id = Number(ins.run(h.chase, d, -(100 + (i % 5000)), `MERCHANT ${i % 700}`).lastInsertRowid);
      sp.run(id, cats[i % cats.length], -(100 + (i % 5000)));
    }
  })();
  const time = (fn: () => unknown) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  it('the months overview stays fast', () => { expect(time(() => monthsOverview(h.db, '2026-10-04'))).toBeLessThan(1500); });
  it('budget page and inbox stay fast', () => {
    expect(time(() => budgetPage(h.db, '2026-10-04'))).toBeLessThan(1000);
    expect(time(() => inbox(h.db))).toBeLessThan(1000);
  });
  it('invariants hold', () => { expect(checkInvariants(h.db)).toEqual([]); });
}, 60_000);
