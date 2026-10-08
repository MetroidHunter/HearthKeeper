import { audit, type DB } from './db.js';
import { categoryBalance, getVersions, monthlyAmount } from './balance.js';
import { monthOf } from './time.js';

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
  /** Round 2: how much each overspent envelope was also asked to receive toward the share of its budget the month has used, and how much of that was found. */
  topUps: { categoryId: number; wantedCents: number; fundedCents: number; day: number; days: number; monthlyCents: number }[];
  resulting: Record<number, number>; // balance of every touched category after commit
}

interface CatInfo { id: number; name: string; kind: string; discretionary: number; cushion_cents: number | null; overage_priority: number | null; balance: number; monthly: number }

function loadBalances(db: DB, asOf: string): CatInfo[] {
  const cats = db.prepare("SELECT * FROM categories WHERE status='active' OR 1=1").all() as any[];
  const month = monthOf(asOf);
  return cats.map((c) => ({ ...c, balance: categoryBalance(db, c.id, asOf).total ?? 0, monthly: monthlyAmount(getVersions(db, c.id), month) })); // monthly: the budget in force that month
}

const EPS = 0.5; // sub-cent legacy drift is not an overage (parity tolerance)

/**
 * The cushion is the amount a category keeps ABOVE its current monthly budget: with a $150 budget and a $50 cushion, money is only taken from it
 * when it holds more than $200 (and then only the excess). Empty means 0: the category keeps exactly its budget. Discretionary categories give first; non-discretionary ones
 * are asked only afterwards, and only for what is above their budget + cushion.
 */
export function keepFloor(c: { monthly: number; cushion_cents: number | null }): number { return c.monthly + (c.cushion_cents ?? 0); }

/** Days of the month already used at `asOf`, as a fraction (day 11 of a 30-day month: 11/30). */
export function monthFraction(asOf: string): { day: number; days: number } {
  const y = Number(asOf.slice(0, 4)), m = Number(asOf.slice(5, 7));
  return { day: Number(asOf.slice(8, 10)), days: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/**
 * Auto-proposal in priority order: the income pool first, then discretionary donors, then non-discretionary ones above budget + cushion (design §13.1).
 * Two rounds, each in priority order. Round 1 covers every overage. Round 2 (unless `topUp: false`) tries to bring each overspent envelope up to the share of its
 * monthly budget that the month has already used: a category at -$70 with a $150 budget on day 11 of 30 is asked to receive $70 + $150 × 11/30 = $125 in total.
 * Round 2 only spends what round 1 left, so a top-up can never take money an overage needed.
 */
export function proposeRebalance(db: DB, asOf: string, opts: { topUp?: boolean } = {}): RebalanceProposal {
  const topUp = opts.topUp !== false;
  const cats = loadBalances(db, asOf);
  const bal = new Map(cats.map((c) => [c.id, c.balance]));
  const over = cats.filter((c) => c.kind === 'expense' && c.balance < -EPS)
    .sort((a, b) => (a.overage_priority ?? 1e9) - (b.overage_priority ?? 1e9) || a.balance - b.balance); // most overspent first among equals
  const overIds = new Set(over.map((c) => c.id));
  const pools = cats.filter((c) => c.kind === 'income_pool' && c.balance > EPS);
  const poolPayments: RebalanceProposal['poolPayments'] = [], donorMoves: RebalanceProposal['donorMoves'] = [];
  const donatable = (c: CatInfo) => {
    if (c.kind !== 'expense') return 0;
    return Math.max(0, Math.floor((bal.get(c.id) ?? 0) - keepFloor(c) + EPS));
  };
  const tiers = [cats.filter((c) => c.discretionary), cats.filter((c) => !c.discretionary)];
  /** Fund `need` (category -> cents wanted) in priority order, pool first; returns what is still unfunded. */
  const fund = (need: Map<number, number>) => {
    for (const pool of pools) {
      let avail = bal.get(pool.id)!;
      for (const o of over) {
        if (avail <= 0) break;
        const n = need.get(o.id) ?? 0;
        if (n <= 0) continue;
        const pay = Math.min(avail, n);
        poolPayments.push({ poolCategoryId: pool.id, toCategoryId: o.id, cents: pay });
        avail -= pay; need.set(o.id, n - pay);
      }
      bal.set(pool.id, avail);
    }
    for (const o of over) {
      for (const tier of tiers) {
        const n = need.get(o.id) ?? 0;
        if (n <= 0) break;
        const donors = tier.filter((d) => d.id !== o.id && donatable(d) > 0 && !overIds.has(d.id));
        const totalDon = donors.reduce((a, d) => a + donatable(d), 0);
        if (!totalDon) continue;
        const take = Math.min(n, totalDon);
        const shares = donors.map((d) => ({ d, v: Math.floor((take * donatable(d)) / totalDon) }));
        let rem = take - shares.reduce((a, s) => a + s.v, 0);
        for (const s of shares.sort((a, b) => donatable(b.d) - donatable(a.d))) { if (rem <= 0) break; if (s.v < donatable(s.d)) { s.v++; rem--; } }
        for (const s of shares) if (s.v > 0) { donorMoves.push({ fromCategoryId: s.d.id, toCategoryId: o.id, cents: s.v }); bal.set(s.d.id, (bal.get(s.d.id) ?? 0) - s.v); }
        need.set(o.id, n - take);
      }
    }
    return need;
  };
  const overage = fund(new Map(over.map((c) => [c.id, -c.balance])));
  const topUps: RebalanceProposal['topUps'] = [];
  if (topUp) {
    const { day, days } = monthFraction(asOf);
    const want = new Map(over.map((c) => [c.id, Math.round((c.monthly * day) / days)] as const).filter(([, v]) => v > 0));
    const left = fund(new Map(want));
    for (const o of over) if (want.has(o.id)) topUps.push({ categoryId: o.id, wantedCents: want.get(o.id)!, fundedCents: want.get(o.id)! - (left.get(o.id) ?? 0), day, days, monthlyCents: o.monthly });
  }
  const merge = <T extends { cents: number }>(xs: T[], key: (x: T) => string): T[] => { const m = new Map<string, T>(); for (const x of xs) { const k = key(x); const e = m.get(k); if (e) e.cents += x.cents; else m.set(k, { ...x }); } return [...m.values()]; };
  return finish(db, asOf, cats, merge(poolPayments, (x) => `${x.poolCategoryId}>${x.toCategoryId}`), merge(donorMoves, (x) => `${x.fromCategoryId}>${x.toCategoryId}`),
    [...overage].filter(([, v]) => v > 0).map(([categoryId, cents]) => ({ categoryId, cents })), topUps);
}

function finish(db: DB, asOf: string, cats: CatInfo[], poolPayments: RebalanceProposal['poolPayments'], donorMoves: RebalanceProposal['donorMoves'], remainingShortfall: RebalanceProposal['remainingShortfall'], topUps: RebalanceProposal['topUps']): RebalanceProposal {
  const resulting: Record<number, number> = {};
  const touch = (id: number) => { if (!(id in resulting)) resulting[id] = cats.find((c) => c.id === id)!.balance; };
  for (const p of poolPayments) { touch(p.poolCategoryId); touch(p.toCategoryId); resulting[p.poolCategoryId] -= p.cents; resulting[p.toCategoryId] += p.cents; }
  for (const d of donorMoves) { touch(d.fromCategoryId); touch(d.toCategoryId); resulting[d.fromCategoryId] -= d.cents; resulting[d.toCategoryId] += d.cents; }
  return { asOf, poolPayments, donorMoves, remainingShortfall, topUps, resulting };
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
