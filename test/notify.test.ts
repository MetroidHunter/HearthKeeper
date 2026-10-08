import { describe, it, expect, beforeEach } from 'vitest';
import { DateTime } from 'luxon';
import { seedHousehold } from './helpers.js';
import { Notifier, getPrefs, setPrefs, inQuietHours } from '../src/notify/notifier.js';
import { memoryTransport } from '../src/notify/push.js';
import { onNotify, clearNotifyHandlers } from '../src/notify/bus.js';
import { captureEvent, replay, parseEvent, clearParsers } from '../src/ingest/events.js';
import { registerAllParsers } from '../src/ingest/parsers.js';
import { addRule } from '../src/core/rules.js';
import { createTransaction, setSplits } from '../src/core/transactions.js';
import { buildApp } from '../src/server/app.js';

const sub = (db: any, userId: number, n = 1) => db.prepare('INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)').run(userId, `https://push.example/${userId}-${n}`, 'k', 'a');
function setup() {
  const h = seedHousehold();
  const u1 = Number(h.db.prepare("INSERT INTO users(name,email) VALUES ('Brys','b@x.com')").run().lastInsertRowid);
  const u2 = Number(h.db.prepare("INSERT INTO users(name,email) VALUES ('Miracle','m@x.com')").run().lastInsertRowid);
  sub(h.db, u1); sub(h.db, u2);
  const t = memoryTransport();
  const now = DateTime.fromISO('2026-10-05T12:00:00', { zone: 'America/Los_Angeles' });
  const n = new Notifier(h.db, t, { now: () => now });
  clearNotifyHandlers(); clearParsers(); registerAllParsers();
  // some categorized history so the one-tap suggestions have something to rank (frequently used categories)
  const day = DateTime.now().toISODate()!;
  for (const [cat, n] of [['Eating Out', 3], ['Groceries', 2]] as const) for (let i = 0; i < n; i++) { const id = createTransaction(h.db, { accountId: h.chase, occurredOn: day, amountCents: -1000, descriptor: `HIST ${cat} ${i}` }); setSplits(h.db, id, [{ categoryId: h.cats[cat], amountCents: -1000 }]); }
  pending.length = 0;
  onNotify((e) => { pending.push(n.handle(e).then(() => undefined)); });
  return { ...h, u1, u2, t, n };
}
const CHASE = (v: string) => `Prime Visa: You made a $9.40 transaction with ${v} on Oct 3, 2026 at 4:11 PM ET.`;
const pending: Promise<void>[] = [];
/** Deterministic: wait for every notification the bus handed to the notifier, instead of sleeping. */
const flush = async () => { await Promise.all(pending); };

describe('notifications (verbose first, design §15.3)', () => {
  beforeEach(() => clearNotifyHandlers());

  it('a live Chase alert for an unknown merchant pushes to BOTH phones with one-tap category actions; the first answer closes the other prompt', async () => {
    const s = setup();
    const ev = captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *NEW CAFE') });
    parseEvent(s.db, ev.id); await flush();
    expect(s.t.sent).toHaveLength(2);
    const p = s.t.sent[0].payload;
    expect(p.title).toMatch(/NEW CAFE \$9\.40/); expect(p.actions!.length).toBe(2); expect(p.tag).toMatch(/^txn-/);
    const txnId = p.id!;
    s.t.sent.length = 0;
    const closed = await s.n.retract(txnId, s.u1);
    expect(closed).toEqual([s.u2]);
    expect(s.t.sent).toHaveLength(1);
    expect(s.t.sent[0].payload).toMatchObject({ close: true, tag: `txn-${txnId}` });
    expect(s.t.sent[0].sub.user_id).toBe(s.u2);
  });

  it('auto-categorized transactions never push (they go in the digest); same alert is not pushed twice', async () => {
    const s = setup();
    addRule(s.db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'cafe' }] }, action: { type: 'categorize', category: 'Eating Out' }, mode: 'auto' });
    parseEvent(s.db, captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *KNOWN CAFE') }).id); await flush();
    expect(s.t.sent).toHaveLength(0);
    const d = s.n.digest();
    expect(d.autoCategorized.map((a) => a.descriptor)).toContain('SQ *KNOWN CAFE');
    expect(d.text).toMatch(/1 auto-categorized/);
    // a second needs_you for the same txn is suppressed
    parseEvent(s.db, captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *OTHER PLACE') }).id); await flush();
    const first = s.t.sent.length; const txn = s.t.sent[0].payload.id!;
    await s.n.needsYou(txn, 'fast');
    expect(s.t.sent.length).toBe(first);
  });

  it('replaying stored events never re-notifies about the past', async () => {
    const s = setup();
    captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *OLD PLACE') });
    replay(s.db); await flush();
    expect(s.t.sent).toHaveLength(0);
  });

  it('greenlight: nothing the cards do notifies any more (spending, requests, declines)', async () => {
    const s = setup();
    const gl = (m: string) => parseEvent(s.db, captureEvent(s.db, { source: 'greenlight_msg', channel: 'device', payload: `${m} on October 3, 2026 at 09:15AM` }).id);
    gl('Marion spent $7.07 at WAL-MART #3658 GREENSBORO NC'); gl('Marion requests $50.00 to buy groceries');
    gl("Marion's $33.79 purchase at WAL-MART #5393 GREENSBORO NC was declined due to insufficient funds in their GROCERY Spend Control."); await flush();
    expect(s.t.sent).toHaveLength(0);
  });

  it('respects per-user prefs: push off, quiet hours (items still reach the digest), and lock-screen privacy', async () => {
    const s = setup();
    setPrefs(s.db, s.u2, { push: false });
    setPrefs(s.db, s.u1, { lockScreenPrivacy: true });
    parseEvent(s.db, captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *PRIVATE PLACE') }).id); await flush();
    expect(s.t.sent).toHaveLength(1);
    expect(s.t.sent[0].payload.title).toBe('HearthKeeper'); expect(s.t.sent[0].payload.body).not.toMatch(/PRIVATE/);
    const log = s.db.prepare('SELECT user_id, status FROM notification_log ORDER BY user_id').all();
    expect(log).toEqual([{ user_id: s.u1, status: 'sent' }, { user_id: s.u2, status: 'muted' }]);
    expect(inQuietHours({ ...getPrefs(s.db, s.u1), quiet: { enabled: true, start: '22:00', end: '07:00' } }, DateTime.fromISO('2026-10-05T23:30:00'))).toBe(true);
    expect(inQuietHours({ ...getPrefs(s.db, s.u1), quiet: { enabled: true, start: '22:00', end: '07:00' } }, DateTime.fromISO('2026-10-05T12:00:00'))).toBe(false);
    expect(inQuietHours(getPrefs(s.db, s.u1), DateTime.fromISO('2026-10-05T03:00:00'))).toBe(false); // off by default
  });

  it('expired subscriptions (410) are pruned', async () => {
    const s = setup();
    s.t.failWith = 'gone';
    parseEvent(s.db, captureEvent(s.db, { source: 'chase_alert', channel: 'device', payload: CHASE('SQ *GONE') }).id); await flush();
    expect(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get()).toEqual({ c: 0 });
  });

  it('daily digest sends once per user per day, after their digest hour', async () => {
    const s = setup();
    createTransaction(s.db, { accountId: s.chase, occurredOn: '2026-10-04', amountCents: -500, descriptor: 'MYSTERY' });
    expect(await s.n.sendDueDigests()).toEqual([s.u1, s.u2]);
    expect(s.t.sent.every((x) => x.payload.tag === 'digest' && /need you/.test(x.payload.body))).toBe(true);
    expect(await s.n.sendDueDigests()).toEqual([]); // not twice
    const early = new Notifier(s.db, s.t, { now: () => DateTime.fromISO('2026-10-06T06:00:00', { zone: 'America/Los_Angeles' }) });
    expect(await early.sendDueDigests()).toEqual([]); // before 8am
  });

  it('push endpoints: public key, subscribe, prefs, test push', async () => {
    const s = setup();
    const app = buildApp(s.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, notifier: s.n });
    const H = { 'x-requested-with': 'hearthkeeper' };
    const key = (await app.inject({ url: '/api/push/public-key' })).json().publicKey as string;
    expect(key.length).toBeGreaterThan(40);
    expect((await app.inject({ url: '/api/push/public-key' })).json().publicKey).toBe(key); // stable across calls
    expect((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: H, payload: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: H, payload: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } } })).statusCode).toBe(200);
    const prefs = (await app.inject({ method: 'PUT', url: '/api/me/notify-prefs', headers: H, payload: { quiet: { enabled: true, start: '21:00', end: '06:00' }, digestHour: 9 } })).json();
    expect(prefs).toMatchObject({ digestHour: 9, quiet: { enabled: true, start: '21:00', end: '06:00' }, push: true });
    s.t.sent.length = 0;
    const test = (await app.inject({ method: 'POST', url: '/api/push/test', headers: H })).json();
    expect(test.results[0].status).toBe('sent');
    expect(s.t.sent.some((x) => x.payload.title === 'HearthKeeper test')).toBe(true);
    expect((await app.inject({ url: '/api/digest' })).json().text).toMatch(/need you/);
  });

  it('device list: you see and remove only your own devices', async () => {
    const s = setup();
    const app = buildApp(s.db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' }, notifier: s.n });
    const H = { 'x-requested-with': 'hearthkeeper' };
    const mine = s.db.prepare('SELECT id, endpoint FROM push_subscriptions WHERE user_id=?').all(s.u1) as any[];
    const theirs = s.db.prepare('SELECT id, endpoint FROM push_subscriptions WHERE user_id=?').get(s.u2) as any;
    const list = (await app.inject({ url: '/api/push/devices' })).json();
    expect(list.map((d: any) => d.id)).toEqual(mine.map((m) => m.id)); // dev mode acts as the first user
    expect((await app.inject({ method: 'DELETE', url: `/api/push/devices/${theirs.id}`, headers: H })).json()).toEqual({ removed: 0 });
    await app.inject({ method: 'POST', url: '/api/push/unsubscribe', headers: H, payload: { endpoint: theirs.endpoint } });
    expect(s.db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(s.u2)).toEqual({ c: 1 }); // untouched
    expect((await app.inject({ method: 'DELETE', url: `/api/push/devices/${mine[0].id}`, headers: H })).json()).toEqual({ removed: 1 });
    expect((await app.inject({ url: '/api/push/devices' })).json()).toHaveLength(mine.length - 1);
  });
});

describe('uploading a bank CSV is silent', () => {
  it('importing hundreds of rows that all need a category sends no push at all (the morning digest is where they show up)', async () => {
    const s = setup();
    const { commitImport } = await import('../src/ingest/import.js'); const { suggestMapping, parseCsv } = await import('../src/ingest/csv.js');
    const rows = Array.from({ length: 300 }, (_, i) => `10/${String(1 + (i % 28)).padStart(2, '0')}/2026,10/${String(2 + (i % 27)).padStart(2, '0')}/2026,NEVER SEEN SHOP ${i},Shopping,Sale,-${(5 + i).toFixed(2)},`).join('\n');
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n' + rows + '\n';
    const m = suggestMapping(parseCsv(csv));
    const r = commitImport(s.db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 });
    await Promise.all(pending);
    expect(r.imported).toBe(300); expect(r.needsCategory).toBeGreaterThan(250);
    expect(s.t.sent).toHaveLength(0);
    expect(s.db.prepare("SELECT COUNT(*) c FROM notification_log WHERE kind='needs_you'").get()).toEqual({ c: 0 });
    // and the one daily digest does count them
    expect(s.n.digest().text).toMatch(/\d+/);
  });
});
