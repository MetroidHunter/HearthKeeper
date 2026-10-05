/**
 * API server for the browser e2e suite: demo data, dev auth, and a /__e2e/reset route that restores the pristine demo state.
 * Started by web-test-runner.config.mjs. Never part of the production build.
 */
import { openDb, type DB } from '../src/core/db.js';
import { buildApp } from '../src/server/app.js';
import { seedDemo } from '../src/seed/demo.js';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

function reset(db: DB) {
  db.pragma('foreign_keys = OFF');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'").all() as { name: string }[]).map((t) => t.name);
  db.transaction(() => { for (const t of tables) db.prepare(`DELETE FROM ${t}`).run(); })();
  db.pragma('foreign_keys = ON');
  seedDemo(db, today());
}

const db = openDb(':memory:');
reset(db);
const app = buildApp(db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'e2e' } });
app.post('/__e2e/reset', async () => { reset(db); return { ok: true }; });
const port = Number(process.env.E2E_API_PORT ?? 8765);
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E_READY ${port}`);
