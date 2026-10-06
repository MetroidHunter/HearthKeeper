import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from '../core/db.js';
import { withNotifySuppressed } from '../notify/bus.js';
import { forwardedSource } from './forwarded.js';

export type Source = 'chase_alert' | 'chase_csv' | 'wf_csv' | 'simplefin' | 'greenlight_msg' | 'wf_notice' | 'amazon_receipt' | 'venmo_receipt' | 'paypal_receipt' | 'notes_csv' | 'manual' | 'email_unknown' | 'device_unknown';

/** Template fingerprint: numbers, dates, amounts, names replaced by placeholders (design §19.2 Shapes page). */
export function fingerprint(text: string): string {
  return text.slice(0, 2000) // bounded input, and every pattern below is linear-time: forwarded email is attacker-controlled
    .replace(/https?:\/\/\S+/g, '‹url›')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '‹email›')
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?/gi, '‹date›')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, '‹date›')
    .replace(/\b\d{1,2}:\d{2}\s*(?:[AP]M)?/gi, '‹time›')
    .replace(/[$€£]\s?[\d,]+(?:\.\d+)?/g, '‹amt›')
    .replace(/\b\d[\d,.-]*\b/g, '‹n›')
    .replace(/\b[A-Z][a-z]+(?='s\b|’s\b)/g, '‹name›')
    .replace(/\b[A-Z]{2,}[*#]?(?=[A-Z][a-z]|\s|$)/g, '‹caps›')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

export interface CaptureInput { source: Source; channel: 'email' | 'device' | 'upload' | 'api'; payload: string; html?: string | null; headers?: Record<string, string>; tokenId?: number | null; receivedAt?: string; dedupeKey?: string }

/** Store a raw event. Parses nothing (capture first, parse later; design §8.2). Returns {id, duplicate}. */
export function captureEvent(db: DB, c: CaptureInput): { id: number; duplicate: boolean; backfilled?: boolean } {
  const key = c.dedupeKey ?? createHash('sha256').update(c.source + '\0' + c.payload).digest('hex');
  const ex = db.prepare('SELECT id, html FROM raw_events WHERE dedupe_key=?').get(key) as { id: number; html: string | null } | undefined;
  if (ex) {
    // an event stored before the html part was kept: a resend of the same message fills it in, and the caller re-parses it
    if (c.html && !ex.html) { db.prepare('UPDATE raw_events SET html=? WHERE id=?').run(c.html, ex.id); return { id: ex.id, duplicate: true, backfilled: true }; }
    return { id: ex.id, duplicate: true };
  }
  const id = Number(db.prepare(`INSERT INTO raw_events(source, channel, received_at, ingest_token_id, payload, html, headers_json, dedupe_key, fingerprint) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(c.source, c.channel, c.receivedAt ?? new Date().toISOString(), c.tokenId ?? null, c.payload, c.html ?? null, c.headers ? JSON.stringify(c.headers) : null, key, fingerprint(c.payload)).lastInsertRowid);
  if (c.tokenId) db.prepare("UPDATE ingest_tokens SET last_seen_at=datetime('now') WHERE id=?").run(c.tokenId);
  return { id, duplicate: false };
}

/* ---------- tokens ---------- */
export function createToken(db: DB, label: string, channel: 'email' | 'device' | 'api', expectedCadenceHours?: number): { id: number; secret: string } {
  const secret = randomBytes(24).toString('hex');
  const id = Number(db.prepare('INSERT INTO ingest_tokens(label, channel, secret, expected_cadence_hours) VALUES (?,?,?,?)').run(label, channel, secret, expectedCadenceHours ?? null).lastInsertRowid);
  return { id, secret };
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function sign(secret: string, ts: string, nonce: string, body: string): string { return createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex'); }

export interface AuthInput { label?: string; signature?: string; timestamp?: string; nonce?: string; bearer?: string; body: string; now?: number }
/**
 * HMAC mode (Apps Script): signature over ts.nonce.body with replay protection (±5 min, nonce stored).
 * Bearer mode (IFTTT's webhook action cannot add headers or compute signatures, so a secret in the URL is accepted).
 */
export function authenticate(db: DB, a: AuthInput, expectedChannel: string): { ok: true; tokenId: number } | { ok: false; reason: string } {
  const now = a.now ?? Date.now();
  if (a.signature && a.label) {
    const t = db.prepare('SELECT id, secret, channel FROM ingest_tokens WHERE label=?').get(a.label) as any;
    if (!t || t.channel !== expectedChannel) return { ok: false, reason: 'unknown token' };
    const ts = Number(a.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > 5 * 60_000) return { ok: false, reason: 'stale timestamp' };
    if (!a.nonce || !safeEq(sign(t.secret, a.timestamp!, a.nonce, a.body), a.signature)) return { ok: false, reason: 'bad signature' };
    const ins = db.prepare('INSERT OR IGNORE INTO ingest_nonces(token_id, nonce, ts) VALUES (?,?,?)').run(t.id, a.nonce, ts);
    if (ins.changes === 0) return { ok: false, reason: 'replayed nonce' };
    db.prepare('DELETE FROM ingest_nonces WHERE ts < ?').run(Math.floor(now / 1000) - 3600);
    return { ok: true, tokenId: t.id };
  }
  if (a.bearer) {
    const rows = db.prepare('SELECT id, secret FROM ingest_tokens WHERE channel=?').all(expectedChannel) as any[];
    const hit = rows.find((r) => safeEq(r.secret, a.bearer!));
    if (hit) return { ok: true, tokenId: hit.id };
  }
  return { ok: false, reason: 'unauthorized' };
}

/* ---------- Shapes page ---------- */
export interface ShapeCluster { fingerprint: string; source: string; count: number; first_seen: string; last_seen: string; examples: string[]; decision: string | null; unparsed: number }
export function shapes(db: DB): ShapeCluster[] {
  const rows = db.prepare(`SELECT fingerprint, source, COUNT(*) count, MIN(received_at) first_seen, MAX(received_at) last_seen,
      SUM(CASE WHEN parse_status IN ('pending','unrecognized') THEN 1 ELSE 0 END) unparsed FROM raw_events GROUP BY fingerprint, source ORDER BY count DESC`).all() as any[];
  return rows.map((r) => ({
    ...r,
    examples: (db.prepare('SELECT payload FROM raw_events WHERE fingerprint=? AND source=? ORDER BY id DESC LIMIT 3').all(r.fingerprint, r.source) as any[]).map((x) => x.payload),
    decision: (db.prepare('SELECT decision FROM shape_decisions WHERE fingerprint=? AND source=?').get(r.fingerprint, r.source) as any)?.decision ?? null,
  }));
}
export function decideShape(db: DB, fp: string, source: string, decision: 'parser' | 'noise' | 'needs_look') {
  db.prepare('INSERT INTO shape_decisions(fingerprint, source, decision) VALUES (?,?,?) ON CONFLICT(fingerprint, source) DO UPDATE SET decision=excluded.decision, decided_at=datetime(\'now\')').run(fp, source, decision);
  if (decision === 'noise') db.prepare("UPDATE raw_events SET parse_status='noise' WHERE fingerprint=? AND source=? AND parse_status IN ('pending','unrecognized')").run(fp, source);
}

/* ---------- parsers and replay ---------- */
export interface RawEvent { id: number; source: string; channel: string; received_at: string; payload: string; html?: string | null; headers_json: string | null; parse_status: string }
export type ParseResult = { status: 'ok' | 'noise' | 'unrecognized' | 'error'; error?: string };
export interface Parser { source: string; version: string; parse(db: DB, ev: RawEvent): ParseResult }

const registry = new Map<string, Parser>();
export function registerParser(p: Parser) { registry.set(p.source, p); }
export function clearParsers() { registry.clear(); }

/** Parse one stored event; unknown sources stay `pending` and never create transactions (§19.2). */
export function parseEvent(db: DB, id: number): ParseResult | null {
  let ev = db.prepare('SELECT * FROM raw_events WHERE id=?').get(id) as RawEvent;
  const fwd = forwardedSource(db, ev); // a household member's hand-forward: parse it as the original sender's mail
  if (fwd) {
    const h = { ...JSON.parse(ev.headers_json ?? '{}'), 'X-HK-Original-From': fwd.originalFrom };
    db.prepare('UPDATE raw_events SET source=?, headers_json=? WHERE id=?').run(fwd.source, JSON.stringify(h), id);
    ev = db.prepare('SELECT * FROM raw_events WHERE id=?').get(id) as RawEvent;
  }
  const p = registry.get(ev.source);
  if (!p) return null;
  let r: ParseResult;
  try { r = p.parse(db, ev); } catch (e) { r = { status: 'error', error: String((e as Error).message) }; }
  db.prepare('UPDATE raw_events SET parse_status=?, parser_version=?, error=? WHERE id=?').run(r.status, p.version, r.error ?? null, id);
  return r;
}

/** Replay stored events through current parsers. Safe to run repeatedly: parsers are idempotent per raw event id. */
export function replay(db: DB, opts: { source?: string; includeOk?: boolean } = {}): { replayed: number; byStatus: Record<string, number> } {
  const where = [opts.source ? 'source=?' : '1=1', opts.includeOk ? '1=1' : "parse_status IN ('pending','unrecognized','error')"].join(' AND ');
  const ids = (opts.source ? db.prepare(`SELECT id FROM raw_events WHERE ${where} ORDER BY id`).all(opts.source) : db.prepare(`SELECT id FROM raw_events WHERE ${where} ORDER BY id`).all()) as { id: number }[];
  const byStatus: Record<string, number> = {};
  let replayed = 0;
  withNotifySuppressed(() => {
    for (const { id } of ids) {
      const r = parseEvent(db, id);
      if (!r) continue;
      replayed++; byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }
  });
  return { replayed, byStatus };
}

/** Silence alerts (§8.7): tokens quiet longer than their expected cadence. */
export function silentTokens(db: DB, nowIso = new Date().toISOString()): { id: number; label: string; hoursSilent: number }[] {
  const rows = db.prepare('SELECT id, label, last_seen_at, expected_cadence_hours h FROM ingest_tokens WHERE expected_cadence_hours IS NOT NULL').all() as any[];
  const now = Date.parse(nowIso);
  return rows.map((r) => ({ id: r.id, label: r.label, hoursSilent: r.last_seen_at ? (now - Date.parse(r.last_seen_at.replace(' ', 'T') + 'Z')) / 3600_000 : Infinity }))
    .filter((r) => r.hoursSilent > rows.find((x) => x.id === r.id).h);
}
