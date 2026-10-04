import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { captureEvent, createToken, authenticate, sign, shapes, replay, fingerprint, clearParsers, silentTokens } from '../src/ingest/events.js';
import { registerGreenlightParser } from '../src/greenlight/parser.js';

beforeEach(() => clearParsers());

describe('capture and replay', () => {
  it('stores everything raw, de-dupes, and replays idempotently once a parser exists', () => {
    const h = seedHousehold();
    const msgs = ['$50.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM', '$100.00 allowance transferred to Marion on October 3, 2026 at 09:16AM'];
    for (const m of msgs) captureEvent(h.db, { source: 'greenlight_msg', channel: 'device', payload: m });
    expect(captureEvent(h.db, { source: 'greenlight_msg', channel: 'device', payload: msgs[0] }).duplicate).toBe(true);
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 }); // no parser yet: nothing created
    registerGreenlightParser();
    expect(replay(h.db).replayed).toBe(2);
    const snap = () => JSON.stringify(h.db.prepare('SELECT * FROM transactions ORDER BY id').all());
    const first = snap();
    replay(h.db, { includeOk: true });
    expect(snap()).toBe(first); // second replay changes nothing
    expect(h.db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 2 });
  });

  it('unknown shapes are never silently parsed; they cluster by fingerprint', () => {
    const h = seedHousehold();
    captureEvent(h.db, { source: 'chase_alert', channel: 'email', payload: 'You made a $12.30 transaction with SQ *CAFE on Oct 3, 2026 at 4:11 PM ET' });
    captureEvent(h.db, { source: 'chase_alert', channel: 'email', payload: 'You made a $9.40 transaction with SQ *NEW CAFE on Oct 4, 2026 at 8:02 AM ET' });
    const cl = shapes(h.db);
    expect(fingerprint('Paid $12.30 on Oct 3, 2026')).toBe(fingerprint('Paid $9.99 on Oct 9, 2026'));
    expect(cl.length).toBeLessThanOrEqual(2);
    expect(cl.reduce((a, c) => a + c.count, 0)).toBe(2);
  });
});

describe('ingest auth', () => {
  it('hmac with replay protection, and bearer mode', () => {
    const h = seedHousehold();
    const t = createToken(h.db, 'receiver', 'email');
    const body = '{"x":1}', ts = String(Math.floor(Date.now() / 1000)), nonce = 'n1';
    const sig = sign(t.secret, ts, nonce, body);
    expect(authenticate(h.db, { label: 'receiver', signature: sig, timestamp: ts, nonce, body }, 'email').ok).toBe(true);
    expect(authenticate(h.db, { label: 'receiver', signature: sig, timestamp: ts, nonce, body }, 'email')).toMatchObject({ ok: false, reason: 'replayed nonce' });
    expect(authenticate(h.db, { label: 'receiver', signature: 'bad', timestamp: ts, nonce: 'n2', body }, 'email')).toMatchObject({ ok: false });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(authenticate(h.db, { label: 'receiver', signature: sign(t.secret, old, 'n3', body), timestamp: old, nonce: 'n3', body }, 'email')).toMatchObject({ reason: 'stale timestamp' });
    const d = createToken(h.db, 'phone', 'device', 24);
    expect(authenticate(h.db, { bearer: d.secret, body }, 'device').ok).toBe(true);
    expect(authenticate(h.db, { bearer: d.secret, body }, 'email').ok).toBe(false);
    expect(silentTokens(h.db, new Date(Date.now() + 48 * 3600_000).toISOString()).map((s) => s.label)).toContain('phone');
  });
});
