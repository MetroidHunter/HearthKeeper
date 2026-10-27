import { audit, type DB } from './db.js';
import { categoryBalance, getVersions, monthlyAmount } from './balance.js';
import { setBudget, retireCategory, retirePreview, rulesForCategory } from './categories.js';
import { createTransfer } from './transfers.js';
import { formatCents as usd } from './money.js';
import { scenarioMonthlyNet } from './earnings.js';
import { monthOf } from './time.js';

type PlanRow = { id: number; status: string; effective_month: string | null; [k: string]: any };

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


/** The plan whose budget is in force in `today`'s month: the latest made live for a month on or before it (a plan going live next month waits its turn). */
export function planInEffect(db: DB, today: string): PlanRow | undefined {
  return (db.prepare('SELECT * FROM budget_plans WHERE made_live_at IS NOT NULL AND effective_month IS NOT NULL AND effective_month<=? ORDER BY effective_month DESC, made_live_at DESC, id DESC LIMIT 1').get(monthOf(today))
    ?? db.prepare("SELECT * FROM budget_plans WHERE status='live'").get()) as PlanRow | undefined;
}
/** draft, live (in force now), scheduled (made live for a later month), or archived. */
export function planPhase(db: DB, p: PlanRow, today: string): 'draft' | 'live' | 'scheduled' | 'archived' {
  if (p.status === 'draft') return 'draft';
  if (planInEffect(db, today)?.id === p.id) return 'live';
  return p.status === 'live' ? 'scheduled' : 'archived';
}

/* ---------- one-time actions that ride along with a go-live ---------- */
export type PlanActionInput = { kind: 'move'; fromCategoryId: number; toCategoryId: number; cents: number } | { kind: 'retire'; categoryId: number; moveBalanceTo?: number | null };
export interface PlanAction { id: number; plan_id: number; kind: 'move' | 'retire'; category_id: number; to_category_id: number | null; cents: number | null; name: string; to_name: string | null; applied_at: string | null; error: string | null }

function activeCategory(db: DB, id: number): { id: number; name: string; status: string; system: number } {
  const c = db.prepare('SELECT id, name, status, system FROM categories WHERE id=?').get(id) as any;
  if (!c) throw new Error('Unknown category');
  if (c.status !== 'active' || c.system) throw new Error(`${c.name} is not active: only active categories can be used`);
  return c;
}
export function addPlanAction(db: DB, planId: number, a: PlanActionInput): number {
  assertDraft(db, planId);
  if (a.kind === 'move') {
    if (typeof a.cents !== 'number' || !Number.isInteger(a.cents) || a.cents <= 0) throw new Error('The amount must be more than $0 (in whole cents)');
    if (a.fromCategoryId === a.toCategoryId) throw new Error('From and to must be different envelopes');
    for (const id of [a.fromCategoryId, a.toCategoryId]) { const c = activeCategory(db, id); if ((db.prepare('SELECT kind FROM categories WHERE id=?').get(id) as any).kind === 'income_reference') throw new Error(`${c.name} holds no money, so money cannot be moved into or out of it`); }
    return Number(db.prepare("INSERT INTO budget_plan_actions(plan_id, kind, category_id, to_category_id, cents) VALUES (?,'move',?,?,?)").run(planId, a.fromCategoryId, a.toCategoryId, a.cents).lastInsertRowid);
  }
  const c = activeCategory(db, a.categoryId);
  if (a.moveBalanceTo) { if (a.moveBalanceTo === a.categoryId) throw new Error('The leftover must go to a different envelope'); activeCategory(db, a.moveBalanceTo); }
  if (db.prepare("SELECT 1 FROM budget_plan_actions WHERE plan_id=? AND kind='retire' AND category_id=?").get(planId, a.categoryId)) throw new Error(`${c.name} is already being retired by this plan`);
  return Number(db.prepare("INSERT INTO budget_plan_actions(plan_id, kind, category_id, to_category_id) VALUES (?,'retire',?,?)").run(planId, a.categoryId, a.moveBalanceTo ?? null).lastInsertRowid);
}
export function removePlanAction(db: DB, planId: number, actionId: number): void {
  assertDraft(db, planId);
  db.prepare('DELETE FROM budget_plan_actions WHERE id=? AND plan_id=?').run(actionId, planId);
}
export function planActions(db: DB, planId: number): PlanAction[] {
  return db.prepare(`SELECT a.*, c.name, t.name to_name FROM budget_plan_actions a JOIN categories c ON c.id=a.category_id LEFT JOIN categories t ON t.id=a.to_category_id WHERE a.plan_id=? ORDER BY a.id`).all(planId) as PlanAction[];
}

/** One plan for its own page: header, items with their group (a draft lists active categories only), its actions, and where it stands. */
export function planDetail(db: DB, planId: number, today = new Date().toISOString().slice(0, 10)) {
  const plan = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as PlanRow | undefined;
  if (!plan) throw Object.assign(new Error('Unknown plan'), { statusCode: 404 });
  const items = db.prepare(`SELECT i.*, c.name, c.kind, c.status category_status, g.name group_name FROM budget_plan_items i JOIN categories c ON c.id=i.category_id LEFT JOIN category_groups g ON g.id=c.group_id
    WHERE i.plan_id=? AND (? != 'draft' OR c.status='active') AND c.system=0 ORDER BY g.sort, g.name, c.sort, c.name`).all(planId, plan.status);
  return { plan, header: planHeader(db, planId), items, actions: planActions(db, planId), phase: planPhase(db, plan, today) };
}

export interface DiffRow { categoryId: number; name: string; oldCents: number; newCents: number; deltaCents: number; restatedBalanceDeltaCents?: number; retiring?: boolean }
export interface MoveLine { id: number; scheduled: boolean; fromName: string; toName: string; cents: number; date: string; fromAfterCents: number; toAfterCents: number; warning: string | null }
export interface RetireLine { id: number; scheduled: boolean; warning: string | null; categoryId: number; name: string; moveToName: string | null; leftoverCents: number; canRetire: boolean; reason: string | null; rulesOff: number }
export interface GoLiveDiff {
  rows: DiffRow[]; historyEntries: number; effectiveMonth: string; retroactive: boolean;
  /** Going live for this month or an earlier one changes the balances that exist today (the month's accrual changes), so each row carries its balance change. */
  touchesBalances: boolean; currentMonth: string;
  incomeOld: number | null; incomeNew: number; allocatedOld: number; allocatedNew: number; unallocatedNew: number;
  staleBase: boolean; // live changed after the draft was created: re-diffed against *current* live
  moves: MoveLine[]; retires: RetireLine[]; blockers: string[];
}

/** Diff a draft against the budget as it stands now (not as it was when the draft was created: staleness guard). */
export function diffPlan(db: DB, planId: number, effectiveMonth: string, today = new Date().toISOString().slice(0, 10)): GoLiveDiff {
  if (!/^\d{4}-\d{2}$/.test(effectiveMonth)) throw new Error('A go-live month is required (YYYY-MM)');
  const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
  const actions = planActions(db, planId);
  const retiring = new Set(actions.filter((a) => a.kind === 'retire').map((a) => a.category_id));
  const items = db.prepare('SELECT i.category_id, i.monthly_cents, c.name, c.kind FROM budget_plan_items i JOIN categories c ON c.id=i.category_id WHERE i.plan_id=? AND c.status=\'active\'').all(planId) as any[];
  for (const id of retiring) if (!items.some((i) => i.category_id === id)) { const c = db.prepare("SELECT name, kind FROM categories WHERE id=? AND status='active'").get(id) as any; if (c) items.push({ category_id: id, monthly_cents: 0, name: c.name, kind: c.kind }); }
  const month = monthOf(today);
  const retro = effectiveMonth < month, touches = effectiveMonth <= month;
  const rows: DiffRow[] = [];
  let allocatedOld = 0, allocatedNew = 0;
  for (const it of items) {
    const v = getVersions(db, it.category_id);
    const old = monthlyAmount(v, effectiveMonth);
    const target = retiring.has(it.category_id) ? 0 : it.monthly_cents;
    if (it.kind === 'expense') { allocatedOld += old; allocatedNew += target; }
    const laterDiffers = v.some((x) => x.effective_month > effectiveMonth && x.monthly_cents !== target);
    if (old === target && !laterDiffers) continue;
    const row: DiffRow = { categoryId: it.category_id, name: it.name, oldCents: old, newCents: target, deltaCents: target - old };
    if (retiring.has(it.category_id)) row.retiring = true;
    if (touches) {
      // Restated balance change = the accrual difference as of today.
      const before = categoryBalance(db, it.category_id, today).accrued;
      const sim = simulateAccrued(db, it.category_id, effectiveMonth, target, today);
      row.restatedBalanceDeltaCents = sim - before;
    }
    rows.push(row);
  }
  const liveNow = planInEffect(db, today);
  const incomeNew = p.scenario_id ? scenarioMonthlyNet(db, p.scenario_id) : 0;

  // moves: dated the first of the go-live month; a future month leaves today's balances alone
  const blockers: string[] = [];
  const date = `${effectiveMonth}-01`, asOf = date > today ? date : today;
  const bal = new Map<number, number>(); const balance = (id: number) => { if (!bal.has(id)) bal.set(id, categoryBalance(db, id, asOf).total ?? 0); return bal.get(id)!; };
  const net = new Map<number, number>();
  const moves: MoveLine[] = actions.filter((a) => a.kind === 'move').map((a) => {
    const fromAfter = balance(a.category_id) - a.cents!, toAfter = balance(a.to_category_id!) + a.cents!;
    bal.set(a.category_id, fromAfter); bal.set(a.to_category_id!, toAfter);
    net.set(a.category_id, (net.get(a.category_id) ?? 0) - a.cents!); net.set(a.to_category_id!, (net.get(a.to_category_id!) ?? 0) + a.cents!);
    return { id: a.id, scheduled: date > today, fromName: a.name, toName: a.to_name!, cents: a.cents!, date, fromAfterCents: fromAfter, toAfterCents: toAfter,
      warning: fromAfter < 0 ? `${a.name} would be overspent by ${usd(-fromAfter)} after this move.` : null };
  });
  const retires: RetireLine[] = actions.filter((a) => a.kind === 'retire').map((a) => {
    const rp = retirePreview(db, a.category_id, effectiveMonth, { today });
    const moved = net.get(a.category_id) ?? 0, now = rp.currentCents + moved, after = rp.afterCents + moved;
    const later = effectiveMonth > month; // it waits for the month, so what matters is the state when it arrives: a warning now, checked again then
    const reason = later ? null
      : now < 0 ? `Cannot retire ${a.name}: it is overspent by ${usd(-now)}. Move money into it (or categorize the spending elsewhere) until it is at $0 or more.`
      : after < 0 ? `Cannot retire ${a.name}: retiring stops its budget for ${effectiveMonth}, which would leave it overspent by ${usd(-after)}. Move at least that much into it first.` : null;
    const warning = later && (now < 0 || after < 0) ? `As things stand ${a.name} would be overspent by ${usd(-Math.min(now, after))} when the month arrives. If it still is, the retirement will not happen and you will be told.` : null;
    if (reason) blockers.push(reason);
    return { id: a.id, scheduled: later, warning, categoryId: a.category_id, name: a.name, moveToName: a.to_name, leftoverCents: Math.max(0, after), canRetire: reason === null, reason, rulesOff: rulesForCategory(db, a.category_id).filter((r) => r.enabled).length };
  });
  return { rows, historyEntries: rows.length, effectiveMonth, retroactive: retro, touchesBalances: touches, currentMonth: month, incomeOld: liveNow?.income_snapshot_cents ?? null, incomeNew, allocatedOld, allocatedNew, unallocatedNew: incomeNew - allocatedNew,
    staleBase: ((db.prepare("SELECT id FROM budget_plans WHERE status='live'").get() as any)?.id ?? null) !== (p.created_from_live_plan_id ?? null), moves, retires, blockers };
}
function simulateAccrued(db: DB, categoryId: number, month: string, cents: number, today: string): number {
  const cat = db.prepare('SELECT start_month FROM categories WHERE id=?').get(categoryId) as { start_month: string };
  const vs = getVersions(db, categoryId).filter((v) => v.effective_month < month);
  vs.push({ effective_month: month, monthly_cents: cents });
  let total = 0;
  for (let m = cat.start_month; m <= monthOf(today); m = nextMonth(m)) total += monthlyAmount(vs, m);
  return total;
}
function nextMonth(m: string): string { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; }

/** Atomic go-live (§12.4): append a version per changed category, apply the plan's moves and retirements, snapshot scenario income, archive the previous live plan, mark live. */
export function makeLive(db: DB, planId: number, opts: { effectiveMonth: string; actor?: string; today?: string; confirmRestate?: string }): GoLiveDiff {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const diff = diffPlan(db, planId, opts.effectiveMonth, today);
  if (diff.retroactive && opts.confirmRestate !== 'RESTATE') throw new Error('Retroactive go-live restates history; type-to-confirm (RESTATE) required');
  if (diff.blockers.length) throw new Error(diff.blockers.join(' '));
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
    if (p.status === 'live') throw new Error('Plan is already live');
    // remember everything this go-live displaces, so a plan that has not taken effect yet can be cancelled
    const undo = { sourcePlanId: planId, month: opts.effectiveMonth, prevLiveId: (db.prepare("SELECT id FROM budget_plans WHERE status='live'").get() as any)?.id ?? null,
      superseded: db.prepare('SELECT id, effective_month FROM budget_plans WHERE made_live_at IS NOT NULL AND effective_month>?').all(opts.effectiveMonth) as any[], displaced: [] as any[], transfers: [] as number[] };
    for (const r of diff.rows) {
      undo.displaced.push(...db.prepare('SELECT category_id, effective_month, monthly_cents, plan_id, reason, created_by FROM category_budget_versions WHERE category_id=? AND effective_month>=?').all(r.categoryId, opts.effectiveMonth));
      const later = db.prepare('DELETE FROM category_budget_versions WHERE category_id=? AND effective_month>?').run(r.categoryId, opts.effectiveMonth).changes;
      if (later) audit(db, 'budget_version', r.categoryId, 'drop_later', undefined, { dropped: later, after: opts.effectiveMonth }, opts.actor);
    }
    for (const r of diff.rows) setBudget(db, r.categoryId, r.newCents, opts.effectiveMonth, { planId, reason: `plan: ${p.name}`, actor: opts.actor });
    // moves and retirements happen together, moves first so an envelope that is topped up can then retire: now when the month has started, otherwise when it arrives (applyDuePlanActions)
    if (opts.effectiveMonth <= monthOf(today)) undo.transfers.push(...runPlanActions(db, planId, p.name, opts.effectiveMonth, today, opts.actor, true).transfers);
    // a plan that was made live for a later month and has not taken effect is overridden by this one
    db.prepare('UPDATE budget_plans SET effective_month=NULL WHERE made_live_at IS NOT NULL AND effective_month>?').run(opts.effectiveMonth);
    db.prepare("UPDATE budget_plans SET status='archived' WHERE status='live'").run();
    // Going live from an archived snapshot is a fresh live row: clone it so the archive stays immutable.
    let liveId = planId;
    if (p.status === 'archived') liveId = cloneAsLive(db, planId);
    db.prepare("UPDATE budget_plans SET status='live', income_snapshot_cents=?, made_live_at=datetime('now'), made_live_by=?, effective_month=?, undo_json=? WHERE id=?").run(diff.incomeNew, opts.actor ?? 'system', opts.effectiveMonth, JSON.stringify(undo), liveId);
    audit(db, 'plan', liveId, 'make_live', undefined, { diff: diff.rows.length, effectiveMonth: opts.effectiveMonth, moves: diff.moves.length, retired: diff.retires.length }, opts.actor);
  })();
  return diff;
}
/** Apply a plan's pending moves, then its retirements, dated the go-live month. `strict` (at go-live, already checked) throws on a retirement that cannot happen; otherwise it is left pending with the reason. */
function runPlanActions(db: DB, planId: number, planName: string, month: string, today: string, actor: string | undefined, strict: boolean) {
  const out = { applied: 0, failed: 0, transfers: [] as number[] };
  const done = (a: PlanAction) => db.prepare('UPDATE budget_plan_actions SET applied_at=?, error=NULL WHERE id=?').run(today, a.id);
  const pending = planActions(db, planId).filter((a) => !a.applied_at);
  for (const m of pending.filter((a) => a.kind === 'move')) {
    out.transfers.push(createTransfer(db, 'manual', `${month}-01`, [{ categoryId: m.category_id, cents: -m.cents! }, { categoryId: m.to_category_id!, cents: m.cents! }], `plan: ${planName}`, actor ?? 'system'));
    done(m); out.applied++;
  }
  for (const r of pending.filter((a) => a.kind === 'retire')) {
    const c = db.prepare('SELECT name, status FROM categories WHERE id=?').get(r.category_id) as { name: string; status: string };
    if (c.status !== 'active') { done(r); continue; } // retired by hand in the meantime
    const prev = retirePreview(db, r.category_id, month, { today });
    if (!prev.canRetire && !strict) {
      out.failed++;
      if (r.error !== prev.reason) {
        db.prepare('UPDATE budget_plan_actions SET error=? WHERE id=?').run(prev.reason, r.id);
        db.prepare("INSERT INTO notices(kind, category_id, message) VALUES ('plan_retire', ?, ?)").run(r.category_id, `Plan "${planName}" could not retire ${c.name}: ${prev.reason}`);
      }
      continue;
    }
    const dest = r.to_category_id && (db.prepare('SELECT status FROM categories WHERE id=?').get(r.to_category_id) as any)?.status === 'active' ? r.to_category_id : undefined;
    retireCategory(db, r.category_id, month, { moveBalanceTo: dest, disableRules: true, today, actor });
    done(r); out.applied++;
  }
  return out;
}
/** Run the pending moves and retirements of every plan whose go-live month has arrived (called by the scheduler and on API requests; a no-op when nothing is due). */
export function applyDuePlanActions(db: DB, today: string, actor?: string): { applied: number; failed: number } {
  const due = db.prepare(`SELECT DISTINCT p.id, p.name, p.effective_month m FROM budget_plans p JOIN budget_plan_actions a ON a.plan_id=p.id
    WHERE a.applied_at IS NULL AND p.made_live_at IS NOT NULL AND p.effective_month IS NOT NULL AND p.effective_month<=? ORDER BY p.effective_month, p.id`).all(monthOf(today)) as { id: number; name: string; m: string }[];
  const total = { applied: 0, failed: 0 };
  for (const p of due) {
    const r = db.transaction(() => runPlanActions(db, p.id, p.name, p.m, today, actor, false))();
    total.applied += r.applied; total.failed += r.failed;
    if (r.applied) audit(db, 'plan', p.id, 'apply_actions', undefined, { month: p.m, applied: r.applied }, actor);
  }
  return total;
}

/**
 * Cancel a plan that was made live for a later month and has not taken effect: its budget versions go, what it deleted or overwrote comes back,
 * its (future-dated) transfers are removed, the plan that was live is live again, and the plan returns to a draft you can edit or schedule again.
 * A plan whose month has arrived is in force and is replaced by making another plan live instead.
 */
export function cancelScheduled(db: DB, planId: number, opts: { today?: string; actor?: string } = {}): void {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM budget_plans WHERE id=?').get(planId) as any;
    if (!p || p.status !== 'live' || !p.effective_month || p.effective_month <= monthOf(today) || !p.undo_json) throw new Error('Only a scheduled plan (made live for a later month) can be cancelled');
    const u = JSON.parse(p.undo_json) as { sourcePlanId: number; month: string; prevLiveId: number | null; superseded: { id: number; effective_month: string }[]; displaced: any[]; transfers: number[] };
    db.prepare('DELETE FROM category_budget_versions WHERE plan_id=? AND effective_month=?').run(u.sourcePlanId, u.month);
    const put = db.prepare('INSERT OR REPLACE INTO category_budget_versions(category_id, monthly_cents, effective_month, plan_id, reason, created_by) VALUES (?,?,?,?,?,?)');
    for (const v of u.displaced) put.run(v.category_id, v.monthly_cents, v.effective_month, v.plan_id, v.reason, v.created_by);
    for (const t of u.transfers) { db.prepare('DELETE FROM envelope_transfer_legs WHERE transfer_id=?').run(t); db.prepare('DELETE FROM envelope_transfers WHERE id=?').run(t); }
    if (u.prevLiveId) db.prepare("UPDATE budget_plans SET status='live' WHERE id=?").run(u.prevLiveId);
    for (const s of u.superseded) db.prepare('UPDATE budget_plans SET effective_month=? WHERE id=?').run(s.effective_month, s.id);
    db.prepare("UPDATE budget_plans SET status='draft', effective_month=NULL, made_live_at=NULL, made_live_by=NULL, income_snapshot_cents=NULL, undo_json=NULL, version=version+1 WHERE id=?").run(planId);
    audit(db, 'plan', planId, 'cancel_scheduled', undefined, { month: u.month, restoredVersions: u.displaced.length, transfersRemoved: u.transfers.length }, opts.actor);
  })();
}
function cloneAsLive(db: DB, archivedId: number): number {
  const a = db.prepare('SELECT name, scenario_id FROM budget_plans WHERE id=?').get(archivedId) as any;
  const id = Number(db.prepare("INSERT INTO budget_plans(name, scenario_id, base_note) VALUES (?,?,?)").run(`${a.name} (reactivated)`, a.scenario_id, `revert from plan ${archivedId}`).lastInsertRowid);
  db.prepare('INSERT INTO budget_plan_items(plan_id, category_id, monthly_cents, note) SELECT ?, category_id, monthly_cents, note FROM budget_plan_items WHERE plan_id=?').run(id, archivedId);
  return id;
}
