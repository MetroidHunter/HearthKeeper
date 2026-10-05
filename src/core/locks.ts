import { audit, type DB } from './db.js';

/** Optional soft lock (design §13.4, Phase 5): once a month is closed, human edits to it need an explicit, audited reopen. */
export class PeriodClosedError extends Error { statusCode = 409; constructor(public through: string) { super(`Period through ${through} is closed; reopen it first`); } }

export function lockedThrough(db: DB): string | null { return (db.prepare('SELECT MAX(through_date) d FROM close_periods').get() as { d: string | null }).d ?? null; }
export function assertOpen(db: DB, date: string): void { const l = lockedThrough(db); if (l && date <= l) throw new PeriodClosedError(l); }
export function isOpenMonth(db: DB, month: string): boolean { const l = lockedThrough(db); return !l || `${month}-31` > l; }

/** Reopen from a closed period onward (removes that lock and any later ones). Always audited with a reason. */
export function reopenPeriod(db: DB, periodId: number, actor: string, reason: string): number {
  if (!reason.trim()) throw new Error('a reason is required to reopen a closed period');
  const p = db.prepare('SELECT * FROM close_periods WHERE id=?').get(periodId) as { id: number; through_date: string } | undefined;
  if (!p) throw new Error('unknown period');
  const n = db.prepare('DELETE FROM close_periods WHERE through_date >= ?').run(p.through_date).changes;
  audit(db, 'close_period', periodId, 'reopen', { through: p.through_date }, { reason }, actor);
  return n;
}
export function listPeriods(db: DB) { return db.prepare('SELECT id, through_date, closed_by, closed_at FROM close_periods ORDER BY through_date DESC').all(); }
