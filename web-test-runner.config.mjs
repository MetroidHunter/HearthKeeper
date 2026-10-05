import { spawn } from 'node:child_process';
import { chromeLauncher } from '@web/test-runner-chrome';
import { esbuildPlugin } from '@web/dev-server-esbuild';

const API_PORT = Number(process.env.E2E_API_PORT ?? 8765);
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let api;

/** Boots the Fastify API (demo data) in a child process and proxies /api, /auth and /__e2e to it, so the real UI talks to the real server. */
const apiPlugin = {
  name: 'hk-api',
  async serverStart() {
    api = spawn(process.execPath, ['--import', 'tsx', 'e2e/server.ts'], { env: { ...process.env, E2E_API_PORT: String(API_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('e2e API did not start')), 30000);
      api.stdout.on('data', (d) => { if (String(d).includes('E2E_READY')) { clearTimeout(t); resolve(); } });
      api.on('exit', (c) => reject(new Error(`e2e API exited early (${c})`)));
    });
  },
  serverStop() { api?.kill(); },
};

const proxy = async (ctx, next) => {
  if (!/^\/(api|auth|ingest|__e2e)\//.test(ctx.url)) return next();
  const chunks = [];
  for await (const c of ctx.req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await fetch(`http://127.0.0.1:${API_PORT}${ctx.url}`, { method: ctx.method, headers: { 'content-type': ctx.get('content-type') || 'application/json', 'x-requested-with': ctx.get('x-requested-with') || '', cookie: ctx.get('cookie') || '' }, body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : body });
  ctx.status = r.status;
  ctx.set('content-type', r.headers.get('content-type') ?? 'application/json');
  for (const c of r.headers.getSetCookie?.() ?? []) ctx.append('set-cookie', c.replace(/;\s*Secure/i, '')); // the e2e origin is plain http
  ctx.body = Buffer.from(await r.arrayBuffer());
};

export default {
  files: 'e2e/**/*.test.js',
  nodeResolve: true,
  concurrency: 1, // every test file shares one API server and resets it first
  testsFinishTimeout: 120000,
  testFramework: { config: { timeout: 15000 } },
  browsers: [chromeLauncher({ launchOptions: { executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } })],
  plugins: [esbuildPlugin({ ts: true, tsconfig: './tsconfig.json', target: 'auto' }), apiPlugin],
  middleware: [proxy],
  // echarts references process.env.NODE_ENV inside node_modules, which the dev server does not rewrite
  testRunnerHtml: (testFramework) => `<!doctype html><html><body><script>window.process={env:{NODE_ENV:'development'}};</script><script type="module" src="${testFramework}"></script></body></html>`,
};
