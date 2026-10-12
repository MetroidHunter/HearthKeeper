import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedHousehold } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { parseUpdateLog } from '../src/ops/updater.js';

const H = { 'x-requested-with': 'hearthkeeper' };

describe('parseUpdateLog', () => {
  it('knows never / running / ok / failed, and returns only the last lines', () => {
    expect(parseUpdateLog('').state).toBe('never');
    expect(parseUpdateLog('== update started 2026-10-12T10:00:00Z\nabc -> def\n').state).toBe('running');
    const ok = parseUpdateLog('== update started 2026-10-12T10:00:00Z\nabc -> def\n== update finished ok 2026-10-12T10:02:00Z\n');
    expect(ok).toMatchObject({ state: 'ok', startedAt: '2026-10-12T10:00:00Z', finishedAt: '2026-10-12T10:02:00Z' });
    expect(parseUpdateLog('== update started a\n== update finished failed (exit 2) b\n').state).toBe('failed');
    // only the latest run counts
    expect(parseUpdateLog('== update started a\n== update finished failed (exit 2) b\n== update started c\n').state).toBe('running');
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    expect(parseUpdateLog(`== update started a\n${long}\n`).tail.split('\n')).toHaveLength(40);
  });
});

describe('admin update API', () => {
  let dir: string, requestFile: string, logFile: string, unitFile: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hk-admin-')); requestFile = join(dir, 'update.request'); logFile = join(dir, 'update.log'); unitFile = join(dir, 'unit'); writeFileSync(unitFile, ''); });
  const app = (user: string, ready = true) => buildApp(seedHousehold().db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x', devUser: user }, admin: { emails: ['Admin@Example.com'], requestFile, logFile, unitFile: ready ? unitFile : join(dir, 'missing') } });

  it('a non-admin sees admin:false, and cannot start an update', async () => {
    const a = app('someone@example.com');
    expect((await a.inject({ url: '/api/admin/update' })).json()).toEqual({ admin: false });
    expect((await a.inject({ method: 'POST', url: '/api/admin/update', headers: H })).statusCode).toBe(403);
    expect(existsSync(requestFile)).toBe(false);
  });

  it('an admin (matched case-insensitively) sees the status and can request an update once', async () => {
    const a = app('admin@example.com');
    expect((await a.inject({ url: '/api/admin/update' })).json()).toMatchObject({ admin: true, ready: true, state: 'never', pending: false });
    const r = await a.inject({ method: 'POST', url: '/api/admin/update', headers: H });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(requestFile, 'utf8')).by).toBe('admin@example.com');
    expect((await a.inject({ url: '/api/admin/update' })).json()).toMatchObject({ pending: true });
    expect((await a.inject({ method: 'POST', url: '/api/admin/update', headers: H })).statusCode).toBe(409); // already requested
  });

  it('refuses while an update is running, and reports the last result', async () => {
    const a = app('admin@example.com');
    writeFileSync(logFile, '== update started t\nworking\n');
    expect((await a.inject({ method: 'POST', url: '/api/admin/update', headers: H })).statusCode).toBe(409);
    writeFileSync(logFile, '== update started t\nabc -> def\n== update finished ok t2\n');
    const s = (await a.inject({ url: '/api/admin/update' })).json();
    expect(s).toMatchObject({ state: 'ok' }); expect(s.tail).toContain('abc -> def');
  });

  it('says it is not set up when the systemd unit is not installed, and will not queue a request nobody will run', async () => {
    const a = app('admin@example.com', false);
    expect((await a.inject({ url: '/api/admin/update' })).json()).toMatchObject({ admin: true, ready: false });
    expect((await a.inject({ method: 'POST', url: '/api/admin/update', headers: H })).statusCode).toBe(409);
    expect(existsSync(requestFile)).toBe(false);
  });

  it('with no admin configured at all nobody is an admin', async () => {
    const a = buildApp(seedHousehold().db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x', devUser: 'admin@example.com' } });
    expect((await a.inject({ url: '/api/admin/update' })).json()).toEqual({ admin: false });
    expect((await a.inject({ method: 'POST', url: '/api/admin/update', headers: H })).statusCode).toBe(403);
  });

  it('requires the CSRF header', async () => {
    expect((await app('admin@example.com').inject({ method: 'POST', url: '/api/admin/update' })).statusCode).toBe(403);
  });
});
