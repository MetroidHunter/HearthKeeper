/**
 * API server for the browser e2e suite: demo data, dev auth, and a /__e2e/reset route that restores the pristine demo state.
 * Started by web-test-runner.config.mjs. Never part of the production build.
 */
import { openDb, type DB } from '../src/core/db.js';
import { buildApp } from '../src/server/app.js';
import { seedDemo } from '../src/seed/demo.js';
import { createTransaction } from '../src/core/transactions.js';
import { grandfatherSeed, SEED_LABEL } from '../src/migration/grandfather.js';

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
const auth = { mode: 'dev' as 'dev' | 'google', allowlist: ['me@example.com'], googleClientId: 'e2e-client-id.apps.googleusercontent.com', sessionSecret: 'e2e-secret' };
// fake Google: 'good-token' is an allowed user, 'stranger-token' is a valid Google user who is not on the allowlist
const verifyIdToken = async (t: string) => (t === 'good-token' ? 'me@example.com' : t === 'stranger-token' ? 'stranger@example.com' : null);
const app = buildApp(db, { auth, verifyIdToken });
app.post('/__e2e/auth-mode', async (req) => { auth.mode = (req.body as { mode: 'dev' | 'google' }).mode; return { ok: true, mode: auth.mode }; });
app.post('/__e2e/reset', async () => { auth.mode = 'dev'; reset(db); return { ok: true }; });
// an imported-from-the-sheet style row with no category, then the same grandfathering the real server runs at startup
app.post('/__e2e/seed-reserved', async () => {
  const acct = (db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get() as { id: number }).id;
  const id = createTransaction(db, { accountId: acct, occurredOn: '2025-03-04', amountCents: -1234, descriptor: 'RESERVED IMPORT ROW' });
  db.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').run(id);
  db.prepare("INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,memo,origin) VALUES (?,NULL,-1234,'legacy:NEEDS CATEGORY','legacy')").run(id);
  db.prepare("DELETE FROM settings WHERE key='seed_grandfathered'").run();
  grandfatherSeed(db);
  return { categoryId: (db.prepare('SELECT id FROM categories WHERE name=?').get(SEED_LABEL) as { id: number }).id };
});
const port = Number(process.env.E2E_API_PORT ?? 8765);
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E_READY ${port}`);
