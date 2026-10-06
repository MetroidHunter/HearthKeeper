import { audit, type DB } from './db.js';
import { categoryBalance } from './balance.js';

/** Envelope movements (design §13). Transfers are excluded from spend reports by construction. */
export interface Leg { categoryId: number; cents: number }
export type TransferKind = 'reconcile' | 'pool_payment' | 'placement' | 'manual' | 'adjustment' | 'legacy';

export function createTransfer(db: DB, kind: TransferKind, occurredOn: string, legs: Leg[], memo?: string, actor = 'system', legacyName?: string): number {
  const sum = legs.reduce((a, l) => a + l.cents, 0);
  if (kind !== 'adjustment' && kind !== 'legacy' && sum !== 0) throw new Error(`${kind} legs must sum to 0 (got ${sum})`);
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO envelope_transfers(occurred_on, kind, memo, created_by, legacy_name) VALUES (?,?,?,?,?)').run(occurredOn, kind, memo ?? null, actor, legacyName ?? null).lastInsertRowid);
    const ins = db.prepare('INSERT INTO envelope_transfer_legs(transfer_id, category_id, amount_cents) VALUES (?,?,?)');
    for (const l of legs) ins.run(id, l.categoryId, l.cents);
    audit(db, 'envelope_transfer', id, kind, undefined, { legs, memo }, actor);
    return id;
  })();
}
export const manualTransfer = (db: DB, date: string, from: number, to: number, cents: number, memo?: string, actor?: string) =>
  createTransfer(db, 'manual', date, [{ categoryId: from, cents: -cents }, { categoryId: to, cents }], memo, actor);
/** Zero-out: single-leg write-off, allowed to be unbalanced (D31). */
export const adjustment = (db: DB, date: string, categoryId: number, cents: number, reason: string, actor?: string) =>
  createTransfer(db, 'adjustment', date, [{ categoryId, cents }], reason, actor);

export interface RebalanceProposal {
  asOf: string;
  poolPayments: { poolCategoryId: number; toCategoryId: number; cents: number }[];
  donorMoves: { fromCategoryId: number; toCategoryId: number; cents: number }[];
  remainingShortfall: { categoryId: number; cents: number }[];
  resulting: Record<number, number>; // balance of every touched category after commit
}

interface CatInfo { id: number; name: string; kind: string; discretionary: number; cushion_cents: number | null; overage_priority: number | null; balance: number }

function loadBalances(db: DB, asOf: string): CatInfo[] {
  const cats = db.prepare("SELECT * FROM categories WHERE status='active' OR 1=1").all() as any[];
  return cats.map((c) => ({ ...c, balance: categoryBalance(db, c.id, asOf).total ?? 0 }));
}

const EPS = 0.5; // sub-cent legacy drift is not an overage (parity tolerance)

/** Auto-proposal in priority order: Gig Income pool first, then discretionary donors, then non-discretionary above cushion (design §13.1). */
export function proposeRebalance(db: DB, asOf: string): RebalanceProposal {
  const cats = loadBalances(db, asOf);
  const bal = new Map(cats.map((c) => [c.id, c.balance]));
  const over = cats.filter((c) => c.kind === 'expense' && c.balance < -EPS)
    .sort((a, b) => (a.overage_priority ?? 1e9) - (b.overage_priority ?? 1e9) || a.balance - b.balance); // most overspent first among equals
  const pools = cats.filter((c) => c.kind === 'income_pool' && c.balance > EPS);
  const poolPayments: RebalanceProposal['poolPayments'] = [], donorMoves: RebalanceProposal['donorMoves'] = [];
  const need = new Map(over.map((c) => [c.id, -c.balance]));

  for (const pool of pools) {
    let avail = bal.get(pool.id)!;
    for (const o of over) {
      if (avail <= 0) break;
      const n = need.get(o.id)!;
      if (n <= 0) continue;
      const pay = Math.min(avail, n);
      poolPayments.push({ poolCategoryId: pool.id, toCategoryId: o.id, cents: pay });
      avail -= pay; need.set(o.id, n - pay);
    }
    bal.set(pool.id, avail);
  }
  const donatable = (c: CatInfo) => {
    if (c.kind !== 'expense') return 0;
    const cushion = c.discretionary ? (c.cushion_cents ?? 0) : c.cushion_cents;
    if (cushion === null) return 0; // non-discretionary, no cushion: immune
    return Math.max(0, Math.floor((bal.get(c.id) ?? 0) - cushion + EPS));
  };
  const tiers = [cats.filter((c) => c.discretionary), cats.filter((c) => !c.discretionary)];
  for (const o of over) {
    for (const tier of tiers) {
      let n = need.get(o.id)!;
      if (n <= 0) break;
      const donors = tier.filter((d) => d.id !== o.id && donatable(d) > 0 && !need.has(d.id));
      const totalDon = donors.reduce((a, d) => a + donatable(d), 0);
      if (!totalDon) continue;
      const take = Math.min(n, totalDon);
      let given = 0;
      const shares = donors.map((d) => ({ d, v: Math.floor((take * donatable(d)) / totalDon) }));
      given = shares.reduce((a, s) => a + s.v, 0);
      let rem = take - given;
      for (const s of shares.sort((a, b) => donatable(b.d) - donatable(a.d))) { if (rem <= 0) break; if (s.v < donatable(s.d)) { s.v++; rem--; } }
      for (const s of shares) if (s.v > 0) { donorMoves.push({ fromCategoryId: s.d.id, toCategoryId: o.id, cents: s.v }); bal.set(s.d.id, (bal.get(s.d.id) ?? 0) - s.v); }
      need.set(o.id, n - take);
    }
  }
  return finish(db, asOf, cats, poolPayments, donorMoves, [...need].filter(([, v]) => v > 0).map(([categoryId, cents]) => ({ categoryId, cents })));
}

function finish(db: DB, asOf: string, cats: CatInfo[], poolPayments: RebalanceProposal['poolPayments'], donorMoves: RebalanceProposal['donorMoves'], remainingShortfall: RebalanceProposal['remainingShortfall']): RebalanceProposal {
  const resulting: Record<number, number> = {};
  const touch = (id: number) => { if (!(id in resulting)) resulting[id] = cats.find((c) => c.id === id)!.balance; };
  for (const p of poolPayments) { touch(p.poolCategoryId); touch(p.toCategoryId); resulting[p.poolCategoryId] -= p.cents; resulting[p.toCategoryId] += p.cents; }
  for (const d of donorMoves) { touch(d.fromCategoryId); touch(d.toCategoryId); resulting[d.fromCategoryId] -= d.cents; resulting[d.toCategoryId] += d.cents; }
  return { asOf, poolPayments, donorMoves, remainingShortfall, resulting };
}

/** Commit a (possibly hand-edited) proposal: one pool_payment and one reconcile transfer, each summing to zero. */
export function commitRebalance(db: DB, p: Pick<RebalanceProposal, 'asOf' | 'poolPayments' | 'donorMoves'>, actor?: string): { poolTransfer?: number; reconcileTransfer?: number } {
  const out: { poolTransfer?: number; reconcileTransfer?: number } = {};
  const agg = (moves: { fromCategoryId?: number; poolCategoryId?: number; toCategoryId: number; cents: number }[]): Leg[] => {
    const m = new Map<number, number>();
    for (const x of moves) { const f = (x.fromCategoryId ?? x.poolCategoryId)!; m.set(f, (m.get(f) ?? 0) - x.cents); m.set(x.toCategoryId, (m.get(x.toCategoryId) ?? 0) + x.cents); }
    return [...m].filter(([, v]) => v !== 0).map(([categoryId, cents]) => ({ categoryId, cents }));
  };
  db.transaction(() => {
    if (p.poolPayments.length) out.poolTransfer = createTransfer(db, 'pool_payment', p.asOf, agg(p.poolPayments), 'overages paid from pool', actor);
    if (p.donorMoves.length) out.reconcileTransfer = createTransfer(db, 'reconcile', p.asOf, agg(p.donorMoves), 'overages covered by donors', actor);
  })();
  return out;
}

/** Place what's left in a pool by hand (D12). No templates; must not exceed the pool balance. */
export function placePool(db: DB, asOf: string, poolCategoryId: number, allocations: Leg[], actor?: string): number {
  const total = allocations.reduce((a, l) => a + l.cents, 0);
  const avail = categoryBalance(db, poolCategoryId, asOf).total ?? 0;
  if (total > avail) throw new Error(`placing ${total} exceeds pool balance ${avail}`);
  return createTransfer(db, 'placement', asOf, [{ categoryId: poolCategoryId, cents: -total }, ...allocations], 'pool placement', actor);
}
