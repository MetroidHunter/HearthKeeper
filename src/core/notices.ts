import type { DB } from './db.js';
import { categoryBalance } from './balance.js';
import { formatCents } from './money.js';
import { daysBetween } from './time.js';

/**
 * A heads-up on Home when an AUTOMATIC categorization is what pushed an envelope over budget (its balance went from zero or more to below zero).
 * No action is needed, it can be dismissed, and it is only raised for recent spending (history imported in bulk is not news). While one is open for a
 * category (not yet dismissed) no second one is raised for it; after it is dismissed, the next time the envelope is pushed over, it is raised again.
 */
const EPS = 0.5;
export function noteOverage(db: DB, txnId: number, categoryId: number): void {
  const t = db.prepare('SELECT amount_cents a, occurred_on d, kind, COALESCE(descriptor_clean, descriptor_raw) name FROM transactions WHERE id=?').get(txnId) as { a: number; d: string; kind: string; name: string } | undefined;
  if (!t || t.a >= 0 || t.kind !== 'spending') return;
  const c = db.prepare('SELECT name, kind FROM categories WHERE id=?').get(categoryId) as { name: string; kind: string } | undefined;
  if (!c || c.kind !== 'expense') return;
  const latest = (db.prepare("SELECT MAX(occurred_on) d FROM transactions WHERE status!='void'").get() as { d: string }).d;
  if (daysBetween(t.d, latest) > 35) return; // history, not news
  const after = categoryBalance(db, categoryId, latest).total ?? 0, before = after - t.a;
  if (before < -EPS || after >= -EPS) return; // only the payment that crossed the line
  if (db.prepare("SELECT 1 FROM notices WHERE kind='over_budget' AND category_id=? AND dismissed_at IS NULL").get(categoryId)) return;
  db.prepare("INSERT INTO notices(kind, category_id, txn_id, message) VALUES ('over_budget', ?, ?, ?)")
    .run(categoryId, txnId, `${c.name} went over budget: ${formatCents(after)} left in it after ${t.name} (${formatCents(-t.a)}) was filed there automatically.`);
}

export const openNotices = (db: DB) => db.prepare('SELECT id, kind, category_id, txn_id, message, created_at FROM notices WHERE dismissed_at IS NULL ORDER BY id DESC LIMIT 20').all();
export const dismissNotice = (db: DB, id: number) => db.prepare("UPDATE notices SET dismissed_at=datetime('now') WHERE id=? AND dismissed_at IS NULL").run(id).changes > 0;
