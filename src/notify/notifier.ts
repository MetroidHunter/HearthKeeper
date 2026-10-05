import { DateTime } from 'luxon';
import type { DB } from '../core/db.js';
import { HOME_ZONE } from '../core/time.js';
import { formatCents } from '../core/money.js';
import { suggestionsFor } from '../core/reports.js';
import { missingAllowances } from '../greenlight/engine.js';
import { silentTokens } from '../ingest/events.js';
import type { NotifyEvent } from './bus.js';
import type { PushPayload, PushSubscriptionRow, PushTransport } from './push.js';

/** Per-user notification preferences (design §15.3): verbose by default, quiet hours off, lock-screen privacy off. */
export interface NotifyPrefs { push: boolean; quiet: { enabled: boolean; start: string; end: string }; digestHour: number; lockScreenPrivacy: boolean }
export const DEFAULT_PREFS: NotifyPrefs = { push: true, quiet: { enabled: false, start: '22:00', end: '07:00' }, digestHour: 8, lockScreenPrivacy: false };

export function getPrefs(db: DB, userId: number): NotifyPrefs {
  const r = db.prepare('SELECT notify_prefs_json j FROM users WHERE id=?').get(userId) as { j: string } | undefined;
  let saved: Partial<NotifyPrefs> = {};
  try { saved = JSON.parse(r?.j ?? '{}'); } catch { /* defaults */ }
  return { ...DEFAULT_PREFS, ...saved, quiet: { ...DEFAULT_PREFS.quiet, ...(saved.quiet ?? {}) } };
}
export function setPrefs(db: DB, userId: number, patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...getPrefs(db, userId), ...patch, quiet: { ...getPrefs(db, userId).quiet, ...(patch.quiet ?? {}) } };
  db.prepare('UPDATE users SET notify_prefs_json=? WHERE id=?').run(JSON.stringify(next), userId);
  return next;
}

export function inQuietHours(p: NotifyPrefs, now: DateTime): boolean {
  if (!p.quiet.enabled) return false;
  const [sh, sm] = p.quiet.start.split(':').map(Number), [eh, em] = p.quiet.end.split(':').map(Number);
  const mins = now.hour * 60 + now.minute, s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e; // window may wrap midnight
}

export interface Digest { date: string; needsYou: number; flagged: number; staleProvisionals: number; autoCategorized: { id: number; descriptor: string; amountCents: number; category: string | null; ruleId: number | null }[]; silentSources: string[]; missingAllowances: number; text: string }

export class Notifier {
  constructor(private db: DB, private transport: PushTransport, private opts: { now?: () => DateTime } = {}) {}
  private now() { return (this.opts.now ?? (() => DateTime.now()))().setZone(HOME_ZONE); }

  allUsers(): number[] { return (this.db.prepare('SELECT id FROM users ORDER BY id').all() as { id: number }[]).map((u) => u.id); }
  /** The purchaser when known; otherwise both of you (Chase is one shared card; the first answer cancels the other's prompt). */
  audienceFor(txn: { owner_user_id: number | null }): number[] { return txn.owner_user_id ? [txn.owner_user_id] : this.allUsers(); }
  private subs(userId: number) { return this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId) as PushSubscriptionRow[]; }

  /** Send to each user's devices unless push is off or it's quiet hours (quiet items still appear in the daily digest). */
  async sendToUsers(userIds: number[], payload: PushPayload, kind: string, refId: number | null, opts: { ignoreQuiet?: boolean } = {}) {
    const results: { userId: number; status: string }[] = [];
    for (const userId of userIds) {
      const prefs = getPrefs(this.db, userId);
      let status = 'sent';
      if (!prefs.push) status = 'muted';
      else if (!opts.ignoreQuiet && inQuietHours(prefs, this.now())) status = 'quiet';
      else if (this.subs(userId).length === 0) status = 'no_device';
      if (status === 'sent') {
        const body = prefs.lockScreenPrivacy && payload.id ? { ...payload, title: 'HearthKeeper', body: 'Something needs you', actions: payload.actions } : payload;
        for (const s of this.subs(userId)) {
          const r = await this.transport.send(s, body);
          if (r === 'gone') this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
          else if (r === 'ok') this.db.prepare("UPDATE push_subscriptions SET last_ok_at=datetime('now') WHERE id=?").run(s.id);
          else status = 'error';
        }
      }
      this.db.prepare('INSERT INTO notification_log(user_id, kind, ref_id, tag, status) VALUES (?,?,?,?,?)').run(userId, kind, refId, payload.tag ?? null, status);
      results.push({ userId, status });
    }
    return results;
  }

  async handle(e: NotifyEvent) {
    if (e.type === 'needs_you') return this.needsYou(e.txnId, e.lane);
    if (e.type === 'greenlight_inform') return this.sendToUsers(this.allUsers(), { title: 'Greenlight', body: e.message, tag: `gl-${Date.now()}`, url: '/#/greenlight' }, 'greenlight_inform', null);
    if (e.type === 'greenlight_request') {
      const r = this.db.prepare('SELECT r.amount_cents, p.display_name FROM greenlight_requests r JOIN greenlight_profiles p ON p.id=r.profile_id WHERE r.id=?').get(e.requestId) as any;
      return this.sendToUsers(this.allUsers(), { title: `${r.display_name} requests ${formatCents(r.amount_cents)}`, body: 'Approve or decline in HearthKeeper', tag: `glreq-${e.requestId}`, url: '/#/greenlight' }, 'greenlight_request', e.requestId);
    }
    if (e.type === 'silence') return this.sendToUsers(this.allUsers(), { title: 'A source went quiet', body: `No messages from ${e.labels.join(', ')}. Check the capture app.`, tag: 'silence', url: '/#/ingest' }, 'silence', null, { ignoreQuiet: true });
  }

  /** Fast lane only: real-time prompts for items that need a decision. The daily lane waits for the digest. */
  async needsYou(txnId: number, lane: 'fast' | 'daily') {
    if (lane === 'daily') return [];
    const t = this.db.prepare(`SELECT t.id, t.amount_cents, t.descriptor_raw, t.descriptor_clean, t.owner_user_id, t.review_state, t.status, t.kind, t.decided_rule_id, t.flagged, t.flag_reason FROM transactions t WHERE t.id=?`).get(txnId) as any;
    if (!t || t.status === 'void' || (t.review_state !== 'needs_category' && !t.flagged)) return [];
    const audience = this.audienceFor(t).filter((u) => !this.db.prepare("SELECT 1 FROM notification_log WHERE user_id=? AND tag=? AND status IN ('sent','quiet','no_device')").get(u, `txn-${txnId}`));
    if (!audience.length) return [];
    const sug = suggestionsFor(this.db, t);
    const name = t.descriptor_clean || t.descriptor_raw;
    const payload: PushPayload = {
      title: `${name} ${formatCents(Math.abs(t.amount_cents) || 0)}`, body: t.flagged ? String(t.flag_reason ?? 'Needs a look') : sug[0] ? `${sug[0].name}?` : 'Which category?',
      tag: `txn-${txnId}`, url: '/#/', id: txnId, actions: sug.slice(0, 2).map((s) => ({ action: String(s.id), title: s.name })),
    };
    return this.sendToUsers(audience, payload, 'needs_you', txnId);
  }

  /** One person answered: close the same prompt on everyone else's phone (design §15.3). */
  async retract(txnId: number, answeredBy?: number | null) {
    const rows = this.db.prepare("SELECT DISTINCT user_id FROM notification_log WHERE tag=? AND answered_at IS NULL AND status='sent'").all(`txn-${txnId}`) as { user_id: number }[];
    const others = rows.map((r) => r.user_id).filter((u) => u !== answeredBy);
    for (const u of others) for (const s of this.subs(u)) await this.transport.send(s, { title: '', body: '', tag: `txn-${txnId}`, close: true });
    this.db.prepare("UPDATE notification_log SET answered_at=datetime('now') WHERE tag=? AND answered_at IS NULL").run(`txn-${txnId}`);
    return others;
  }

  /** The morning catch-all: what needs you, what was auto-categorized (so a bad rule is noticed), gaps and silence. */
  digest(): Digest {
    const db = this.db, today = this.now().toISODate()!;
    const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { c: number }).c;
    const needsYou = n("SELECT COUNT(*) c FROM transactions WHERE status!='void' AND kind NOT IN ('ignored','internal_transfer') AND review_state='needs_category'");
    const flagged = n("SELECT COUNT(*) c FROM transactions WHERE status!='void' AND flagged=1");
    const stale = n("SELECT COUNT(*) c FROM transactions WHERE status='stale'");
    const auto = (db.prepare(`SELECT t.id, t.descriptor_raw descriptor, t.amount_cents amountCents, t.decided_rule_id ruleId, (SELECT c.name FROM transaction_splits s JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=t.id LIMIT 1) category
      FROM transactions t WHERE t.review_state='auto_categorized' AND t.decided_by='rule' AND t.created_at >= datetime('now','-1 day') AND t.legacy_group IS NULL ORDER BY t.id DESC LIMIT 100`).all() as any[]);
    const silent = silentTokens(db).map((s) => s.label);
    const gaps = missingAllowances(db, today).length;
    const parts = [`${needsYou} need you`, `${auto.length} auto-categorized`];
    if (flagged) parts.push(`${flagged} flagged`); if (stale) parts.push(`${stale} stale pending`); if (gaps) parts.push(`${gaps} missing allowance`); if (silent.length) parts.push(`silent: ${silent.join(', ')}`);
    return { date: today, needsYou, flagged, staleProvisionals: stale, autoCategorized: auto, silentSources: silent, missingAllowances: gaps, text: parts.join(' · ') };
  }

  /** Called by the scheduler: each user gets one digest per day, at or after their digest hour. */
  async sendDueDigests() {
    const now = this.now(), date = now.toISODate()!;
    const sent: number[] = [];
    for (const userId of this.allUsers()) {
      const prefs = getPrefs(this.db, userId);
      const key = `digest_sent:${date}:${userId}`;
      if (now.hour < prefs.digestHour || this.db.prepare('SELECT 1 FROM settings WHERE key=?').get(key)) continue;
      const d = this.digest();
      await this.sendToUsers([userId], { title: 'HearthKeeper morning digest', body: d.text, tag: 'digest', url: '/#/dashboard' }, 'digest', null, { ignoreQuiet: true });
      this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, '1');
      sent.push(userId);
    }
    return sent;
  }

  /** One silence alert per source per day (design §8.7). */
  async checkSilence() {
    const date = this.now().toISODate()!;
    const fresh = silentTokens(this.db).filter((s) => !this.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`silence_alert:${date}:${s.id}`));
    if (!fresh.length) return [];
    for (const s of fresh) this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(`silence_alert:${date}:${s.id}`, '1');
    await this.handle({ type: 'silence', labels: fresh.map((s) => s.label) });
    return fresh.map((s) => s.label);
  }
}
