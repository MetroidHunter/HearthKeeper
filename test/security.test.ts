import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedHousehold } from './helpers.js';
import { buildApp, isPublicHttps } from '../src/server/app.js';
import { createToken, sign, fingerprint } from '../src/ingest/events.js';
import { signSession, verifySession } from '../src/server/auth.js';

const google = (h: ReturnType<typeof seedHousehold>, extra: object = {}) => buildApp(h.db, { auth: { mode: 'google', allowlist: ['me@x.com'], sessionSecret: 'sec' }, ...extra });
const H = { 'x-requested-with': 'hearthkeeper' };

describe('security regressions (from the independent review)', () => {
  it('auth follows the matched route: percent-encoded /api paths cannot skip sign-in or CSRF', async () => {
    const app = google(seedHousehold());
    for (const url of ['/api/accounts', '/%61pi/accounts', '/api/%61ccounts', '/%61%70i/accounts']) expect((await app.inject({ url })).statusCode, url).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/%61pi/ingest/tokens', payload: { label: 'x', channel: 'device' } })).statusCode).toBe(401);
    const cookie = `hk_session=${signSession('sec', 'me@x.com')}`;
    expect((await app.inject({ method: 'POST', url: '/%61pi/rules/backtest', headers: { cookie }, payload: { match: { all_of: [] } } })).statusCode).toBe(403); // CSRF still applies
    expect((await app.inject({ url: '/%61pi/accounts', headers: { cookie } })).statusCode).toBe(200);
  });

  it('fingerprint is linear-time on hostile input', () => {
    for (const evil of ['AA'.repeat(20) + '1', 'AAB'.repeat(200) + '1', 'A'.repeat(100000) + '1']) { const t0 = performance.now(); fingerprint(evil); expect(performance.now() - t0).toBeLessThan(100); }
  });

  it('request bodies are bounded on unauthenticated endpoints; only CSV import routes may be large', async () => {
    const h = seedHousehold(); const app = google(h);
    const tok = createToken(h.db, 'phone', 'device');
    const big = 'x'.repeat(2 * 1024 * 1024);
    expect((await app.inject({ method: 'POST', url: `/ingest/device?token=${tok.secret}`, headers: { 'content-type': 'text/plain' }, payload: big })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/auth/google', payload: { idToken: 'y'.repeat(50000) } })).statusCode).toBe(413);
  });

  it('a secret in the URL is accepted only on the device channel; email must sign or use the Authorization header', async () => {
    const h = seedHousehold(); const app = google(h);
    const dev = createToken(h.db, 'phone', 'device'), mail = createToken(h.db, 'receiver', 'email');
    expect((await app.inject({ method: 'POST', url: `/ingest/device?token=${dev.secret}`, payload: { text: 'hello' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/ingest/email?token=${mail.secret}`, payload: { text: 'hello' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/ingest/email', headers: { authorization: `Bearer ${mail.secret}` }, payload: { text: 'hello' } })).statusCode).toBe(200);
  });

  it('a token cannot forge arbitrary sources', async () => {
    const h = seedHousehold(); const app = google(h);
    const dev = createToken(h.db, 'phone', 'device'), mail = createToken(h.db, 'receiver', 'email');
    expect((await app.inject({ method: 'POST', url: `/ingest/device?token=${dev.secret}&source=amazon_receipt`, payload: { text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/ingest/email?source=greenlight_msg', headers: { authorization: `Bearer ${mail.secret}` }, payload: { text: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/ingest/device?token=${dev.secret}&source=chase_alert`, payload: { text: 'x' } })).statusCode).toBe(200);
  });

  it('heartbeat is HMAC-signed (no URL secret needed) and rejects replays', async () => {
    const h = seedHousehold(); const app = google(h);
    const mail = createToken(h.db, 'receiver', 'email', 24);
    const ts = String(Math.floor(Date.now() / 1000));
    const hdr = { 'x-hk-token': 'receiver', 'x-hk-timestamp': ts, 'x-hk-nonce': 'hb1', 'x-hk-signature': sign(mail.secret, ts, 'hb1', '') };
    expect((await app.inject({ method: 'POST', url: '/ingest/heartbeat', headers: hdr })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/ingest/heartbeat', headers: hdr })).statusCode).toBe(401);
  });

  it('logout needs the CSRF header; malformed multibyte cookies are a 401, not a crash', async () => {
    const app = google(seedHousehold());
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: H })).statusCode).toBe(200);
    expect(verifySession('s', 'aGVsbG8.é'.repeat(1))).toBeNull();
    const body = Buffer.from(JSON.stringify({ email: 'me@x.com', exp: Date.now() + 1e6 })).toString('base64url');
    expect(verifySession('s', `${body}.${'é'.repeat(43)}`)).toBeNull();
    expect((await app.inject({ url: '/api/accounts', headers: { cookie: `hk_session=${body}.${encodeURIComponent('é'.repeat(43))}` } })).statusCode).toBe(401);
  });

  it('API responses are never cacheable, and server errors do not leak internals', async () => {
    const h = seedHousehold(); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    expect((await app.inject({ url: '/api/budget' })).headers['cache-control']).toBe('no-store');
    // a bad id makes the handler throw a TypeError: the client must get a generic message
    const r = await app.inject({ method: 'POST', url: '/api/greenlight/requests/99999/approve', headers: H, payload: {} });
    expect(r.statusCode).toBe(500); expect(r.json().error).toBe('internal error');
  });

  it('the static server cannot be walked out of its directory (including sibling dirs sharing a prefix)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hk-static-')); const dir = join(root, 'dist'), sib = join(root, 'dist-private');
    mkdirSync(dir); mkdirSync(sib); writeFileSync(join(dir, 'index.html'), '<h1>app</h1>'); writeFileSync(join(sib, 'secret.json'), '{"secret":true}'); writeFileSync(join(root, 'top.txt'), 'top');
    const h = seedHousehold(); const app = buildApp(h.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, staticDir: dir });
    for (const url of ['/../dist-private/secret.json', '/%2e%2e/dist-private/secret.json', '/..%2fdist-private%2fsecret.json', '/../top.txt', '/%00', '/a/../../dist-private/secret.json']) {
      const r = await app.inject({ url });
      expect(r.body, url).not.toContain('secret'); expect(r.body, url).not.toBe('top');
    }
    expect((await app.inject({ url: '/' })).body).toContain('app');
  });

  it('push endpoints must be public https URLs (no SSRF into the host or LAN)', () => {
    for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://172.16.0.9/x', 'https://[::1]/x', 'https://intranet/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url']) expect(isPublicHttps(bad), bad).toBe(false);
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x']) expect(isPublicHttps(ok), ok).toBe(true);
  });
});
