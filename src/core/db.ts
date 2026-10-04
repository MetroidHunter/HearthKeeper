import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema.js';

export type DB = Database.Database;

export function openDb(file = ':memory:'): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations(id INTEGER PRIMARY KEY)');
  const done = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i)) return;
    db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _migrations(id) VALUES (?)').run(i); })();
  });
}

export function audit(db: DB, entity: string, entityId: string | number, action: string, before: unknown, after: unknown, actor = 'system') {
  db.prepare('INSERT INTO audit_log(entity, entity_id, action, before_json, after_json, actor) VALUES (?,?,?,?,?,?)')
    .run(entity, String(entityId), action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), actor);
}
