import webpush from 'web-push';
import type { DB } from '../core/db.js';

export interface PushSubscriptionRow { id: number; user_id: number; endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; tag?: string; url?: string; id?: number; actions?: { action: string; title: string }[]; close?: boolean }
export type SendResult = 'ok' | 'gone' | 'error';
export interface PushTransport { send(sub: PushSubscriptionRow, payload: PushPayload): Promise<SendResult> }

/** VAPID keys are generated once and kept in `settings` (plain env/DB, D4: no secret manager). */
export function vapidKeys(db: DB): { publicKey: string; privateKey: string } {
  const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) as { value: string } | undefined)?.value;
  let pub = get('vapid_public'), priv = get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey;
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)').run('vapid_public', pub);
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)').run('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

/** Real transport: the Web Push protocol to the browser's push service. Used only by the production server, never by tests. */
export function webPushTransport(db: DB, subject = process.env.HK_VAPID_SUBJECT ?? 'mailto:admin@example.com'): PushTransport {
  const k = vapidKeys(db);
  webpush.setVapidDetails(subject, k.publicKey, k.privateKey);
  return {
    async send(sub, payload) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 12, urgency: 'high' });
        return 'ok';
      } catch (e: any) { return e?.statusCode === 404 || e?.statusCode === 410 ? 'gone' : 'error'; }
    },
  };
}

/** Test/dev transport: records what would have been sent. Nothing leaves the process. */
export function memoryTransport(): PushTransport & { sent: { sub: PushSubscriptionRow; payload: PushPayload }[]; failWith?: SendResult } {
  const t: any = { sent: [], async send(sub: PushSubscriptionRow, payload: PushPayload) { if (t.failWith) return t.failWith; t.sent.push({ sub, payload }); return 'ok'; } };
  return t;
}
