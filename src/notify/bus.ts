/** Tiny in-process event bus: parsers and engines announce what happened; the notifier decides who to tell (design §15.3). */
export type NotifyEvent =
  | { type: 'needs_you'; txnId: number; lane: 'fast' | 'daily' }
  | { type: 'greenlight_inform'; message: string; profile?: string }
  | { type: 'greenlight_request'; requestId: number }
  | { type: 'silence'; labels: string[] };

type Handler = (e: NotifyEvent) => void | Promise<void>;
const handlers = new Set<Handler>();
export function onNotify(h: Handler): () => void { handlers.add(h); return () => handlers.delete(h); }
let suppressed = 0;
/** Replaying stored events (D2 of the discovery track) must never re-notify about the past. */
export function withNotifySuppressed<T>(fn: () => T): T { suppressed++; try { return fn(); } finally { suppressed--; } }
export function emitNotify(e: NotifyEvent): void {
  if (suppressed) return;
  for (const h of handlers) { try { const r = h(e); if (r instanceof Promise) r.catch((err) => console.error('[notify]', err)); } catch (err) { console.error('[notify]', err); } }
}
export function clearNotifyHandlers() { handlers.clear(); }
