import type { DB } from '../core/db.js';
import { markStale } from '../ingest/import.js';
import { silentTokens } from '../ingest/events.js';
import { runNoteMatcher } from '../notes/matcher.js';
import type { Notifier } from '../notify/notifier.js';

/** Periodic housekeeping (design §17.1): stale provisionals, note re-matching, silence checks. Push delivery plugs into `onAlert`. */
export function startScheduler(db: DB, notifier?: Notifier, onAlert: (kind: string, detail: unknown) => void = (k, d) => console.warn('[alert]', k, JSON.stringify(d))) {
  const tick = async () => {
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      markStale(db, today);
      runNoteMatcher(db);
      const silent = silentTokens(db);
      if (silent.length) onAlert('silence', silent);
      await notifier?.checkSilence();
      await notifier?.sendDueDigests();
    } catch (e) { console.error('scheduler tick failed', e); }
  };
  void tick(); // once at start too, so a deploy never leaves charges waiting for the first timer
  const h = setInterval(() => void tick(), 10 * 60_000);
  h.unref();
  return () => clearInterval(h);
}
