import { audit, type DB } from './db.js';
import { categoryBalance, getVersions, monthlyAmount } from './balance.js';
import { setBudget } from './categories.js';
import { scenarioMonthlyNet } from './earnings.js';
import { monthOf } from './time.js';

export function createPlan(db: DB, name: string, from: 'blank' | { livePlan: true } | { planId: number }, month: string): number {
  return db.transaction(() => {
    const live = db.prepare("SELECT id, scenario_id FROM budget_plans WHERE status='live'").get() as { id: number; scenario_id: number | null } | undefined;
    const id = Number(db.prepare('INSERT INTO budget_plans(name, created_from_live_plan_id) VALUES (?,?)').run(name, live?.id ?? null).lastInsertRowid);
    const cats = db.prepare("SELECT id FROM categories WHERE status='active' AND kind='expense'").all() as { id: number }[];
    const ins = db.prepare('INSERT INTO budget_plan_items(plan_id, category_id, monthly_cents) VALUES (?,?,?)');
    if (from === 'blank') for (const c of cats) ins.run(id, c.id, 0);
    else if ('planId' in from) {
      db.prepare('INSERT INTO budget_plan_items(plan_id, category_id, monthly_cents, note) SELECT ?, category_id, monthly_cents, note FROM budget_plan_items WHERE plan_id=?').run(id, from.planId);
      db.prepare('UPDATE budget_plans SET scenario_id=(SELECT scenario_id FROM budget_plans WHERE id=?) WHERE id=?').run(from.planId, id);
    } else {
      // from live: the *current* effective amounts, so it works even before any plan has gone live
      for (const c of cats) ins.run(id, c.id, monthlyAmount(getVersions(db, c.id), month));
      if (live?.scenario_id) db.prepare('UPDATE budget_plans SET scenario_id=? WHERE id=?').run(live.scenario_id, id);
    }
    return id;
  })();
}

export function setPlanItem(db: DB, planId: number, categoryId: number, monthlyCents: number, note?: string): void {
  assertDraft(db, planId);
  const cat = db.prepare('SELECT status FROM categories WHERE id=?').get(categoryId) as { status: string };
  if (cat.status !== 'active') throw new Error('Plans can only reference active categories');
  db.prepare('INSERT INTO budget_plan_items(plan_id, category_id, monthly_cents, note) VALUES (?,?,?,?) ON CONFLICT(plan_id, category_id) DO UPDATE SET monthly_cents=excluded.monthly_cents, note=COALESCE(excluded.note, note)').run(planId, categoryId, monthlyCents, note ?? null);
  db.prepare('UPDATE budget_plans SET version=version+1 WHERE id=?').run(planId);
}
export function assignScenario(db: DB, planId: number, scenarioId: number | null): void { assertDraft(db, planId); db.prepare('UPDATE budget_plans SET scenario_id=?, version=version+1 WHERE id=?').run(scenarioId, planId); }
function assertDraft(db: DB, id: number) { if ((db.prepare('SELECT status FROM budget_plans WHERE id=?').get(id) as any).status !== 'draft') throw new Error('Only draft plans are editable'); }

/** Bulk aids (§12.4). */
export function bulkAdjust(db: DB, planId: number, opts: { pct?: number; roundTo?: number }): void {
  assertDraft(db, planId);
  for (const it of db.prepare('SELECT category_id, monthly_cents FROM budget_plan_items WHERE plan_id=?').all(planId) as any[]) {
    let v = it.monthly_cents * (1 + (opts.pct ?? 0) / 100);
    if (opts.roundTo) v = Math.round(v / opts.roundTo) * opts.roundTo;
    db.prepare('UPDATE budget_plan_items SET monthly_cents=? WHERE plan_id=? AND category_id=?').run(Math.round(v), planId, it.category_id);
  }
}

export function planAllocated(db: DB, planId: number): number {
  return (db.prepare("SELECT COALESCE(SUM(i.monthly_cents),0) s FROM budget_plan_items i JOIN categories c ON c.id=i.category_id WHERE i.plan_id=? AND c.kind='expense'").get(planId) as any).s;
}
export function planHeader(db: DB, planId: number) {
  const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
  const income = p.status === 'live' && p.income_snapshot_cents != null ? p.income_snapshot_cents : p.scenario_id ? scenarioMonthlyNet(db, p.scenario_id) : 0;
  const allocated = planAllocated(db, planId);
  return { incomeCents: income, allocatedCents: allocated, unallocatedCents: income - allocated, overAllocated: allocated > income };
}

export interface DiffRow { categoryId: number; name: string; oldCents: number; newCents: number; deltaCents: number; restatedBalanceDeltaCents?: number }
export interface GoLiveDiff {
  rows: DiffRow[]; historyEntries: number; effectiveMonth: string; retroactive: boolean;
  incomeOld: number | null; incomeNew: number; allocatedOld: number; allocatedNew: number; unallocatedNew: number;
  staleBase: boolean; // live changed after the draft was created: re-diffed against *current* live
}

/** Diff a draft against the budget as it stands now (not as it was when the draft was created: staleness guard). */
export function diffPlan(db: DB, planId: number, effectiveMonth: string, today = new Date().toISOString().slice(0, 10)): GoLiveDiff {
  const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
  const items = db.prepare('SELECT i.category_id, i.monthly_cents, c.name, c.kind FROM budget_plan_items i JOIN categories c ON c.id=i.category_id WHERE i.plan_id=?').all(planId) as any[];
  const retro = effectiveMonth < monthOf(today);
  const rows: DiffRow[] = [];
  let allocatedOld = 0, allocatedNew = 0;
  for (const it of items) {
    const v = getVersions(db, it.category_id);
    const old = monthlyAmount(v, effectiveMonth);
    if (it.kind === 'expense') { allocatedOld += old; allocatedNew += it.monthly_cents; }
    if (old === it.monthly_cents) continue;
    const row: DiffRow = { categoryId: it.category_id, name: it.name, oldCents: old, newCents: it.monthly_cents, deltaCents: it.monthly_cents - old };
    if (retro) {
      // Restated balance change = the accrual difference as of today.
      const before = categoryBalance(db, it.category_id, today).accrued;
      const sim = simulateAccrued(db, it.category_id, effectiveMonth, it.monthly_cents, today);
      row.restatedBalanceDeltaCents = sim - before;
    }
    rows.push(row);
  }
  const liveNow = db.prepare("SELECT id, scenario_id, income_snapshot_cents FROM budget_plans WHERE status='live'").get() as any;
  const incomeNew = p.scenario_id ? scenarioMonthlyNet(db, p.scenario_id) : 0;
  return { rows, historyEntries: rows.length, effectiveMonth, retroactive: retro, incomeOld: liveNow?.income_snapshot_cents ?? null, incomeNew, allocatedOld, allocatedNew, unallocatedNew: incomeNew - allocatedNew,
    staleBase: (liveNow?.id ?? null) !== (p.created_from_live_plan_id ?? null) };
}
function simulateAccrued(db: DB, categoryId: number, month: string, cents: number, today: string): number {
  const cat = db.prepare('SELECT start_month FROM categories WHERE id=?').get(categoryId) as { start_month: string };
  const vs = getVersions(db, categoryId).filter((v) => v.effective_month !== month);
  vs.push({ effective_month: month, monthly_cents: cents });
  let total = 0;
  for (let m = cat.start_month; m <= monthOf(today); m = nextMonth(m)) total += monthlyAmount(vs, m);
  return total;
}
function nextMonth(m: string): string { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }

/** Atomic go-live (§12.4): append a version per changed category, snapshot scenario income, archive the previous live plan, mark live. */
export function makeLive(db: DB, planId: number, opts: { effectiveMonth: string; actor?: string; today?: string; confirmRestate?: string }): GoLiveDiff {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const diff = diffPlan(db, planId, opts.effectiveMonth, today);
  if (diff.retroactive && opts.confirmRestate !== 'RESTATE') throw new Error('Retroactive go-live restates history; type-to-confirm (RESTATE) required');
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
    if (p.status === 'live') throw new Error('Plan is already live');
    for (const r of diff.rows) setBudget(db, r.categoryId, r.newCents, opts.effectiveMonth, { planId, reason: `plan: ${p.name}`, actor: opts.actor });
    db.prepare("UPDATE budget_plans SET status='archived' WHERE status='live'").run();
    // Going live from an archived snapshot is a fresh live row: clone it so the archive stays immutable.
    let liveId = planId;
    if (p.status === 'archived') liveId = cloneAsLive(db, planId);
    db.prepare("UPDATE budget_plans SET status='live', income_snapshot_cents=?, made_live_at=datetime('now'), made_live_by=?, effective_month=? WHERE id=?").run(diff.incomeNew, opts.actor ?? 'system', opts.effectiveMonth, liveId);
    audit(db, 'plan', liveId, 'make_live', undefined, { diff: diff.rows.length, effectiveMonth: opts.effectiveMonth }, opts.actor);
  })();
  return diff;
}
function cloneAsLive(db: DB, archivedId: number): number {
  const a = db.prepare('SELECT name, scenario_id FROM budget_plans WHERE id=?').get(archivedId) as any;
  const id = Number(db.prepare("INSERT INTO budget_plans(name, scenario_id, base_note) VALUES (?,?,?)").run(`${a.name} (reactivated)`, a.scenario_id, `revert from plan ${archivedId}`).lastInsertRowid);
  db.prepare('INSERT INTO budget_plan_items(plan_id, category_id, monthly_cents, note) SELECT ?, category_id, monthly_cents, note FROM budget_plan_items WHERE plan_id=?').run(id, archivedId);
  return id;
}
