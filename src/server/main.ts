import { mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb } from '../core/db.js';
import { buildApp } from './app.js';
import { startScheduler } from './scheduler.js';

const dataDir = process.env.HK_DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });
const db = openDb(`${dataDir}/hearthkeeper.sqlite`);
const mode = (process.env.HK_AUTH ?? 'google') as 'dev' | 'google';
if (mode === 'google' && !process.env.HK_GOOGLE_CLIENT_ID) console.warn('HK_GOOGLE_CLIENT_ID is not set; sign-in will fail. Use HK_AUTH=dev for local development.');
const staticDir = process.env.HK_STATIC_DIR ?? (existsSync('./dist/web') ? './dist/web' : './src/web/public');
const app = buildApp(db, {
  auth: { mode, allowlist: (process.env.HK_ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean), googleClientId: process.env.HK_GOOGLE_CLIENT_ID, sessionSecret: process.env.HK_SESSION_SECRET ?? randomBytes(32).toString('hex') },
  staticDir: existsSync(staticDir) ? staticDir : undefined,
});
startScheduler(db);
const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }).then(() => console.log(`HearthKeeper listening on :${port} (auth=${mode})`));
