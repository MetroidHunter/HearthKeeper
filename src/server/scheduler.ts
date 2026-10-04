import type { DB } from '../core/db.js';
import { markStale } from '../ingest/import.js';
import { silentTokens } from '../ingest/events.js';
import { runNoteMatcher } from '../notes/matcher.js';

/** Periodic housekeeping (design §17.1): stale provisionals, note re-matching, silence checks. Push delivery plugs into `onAlert`. */
export function startScheduler(db: DB, onAlert: (kind: string, detail: unknown) => void = (k, d) => console.warn('[alert]', k, JSON.stringify(d))) {
  const tick = () => {
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      markStale(db, today);
      runNoteMatcher(db);
      const silent = silentTokens(db);
      if (silent.length) onAlert('silence', silent);
    } catch (e) { console.error('scheduler tick failed', e); }
  };
  const h = setInterval(tick, 10 * 60_000);
  h.unref();
  return () => clearInterval(h);
}
