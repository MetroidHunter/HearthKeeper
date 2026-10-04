import { registerParser } from '../ingest/events.js';
import { processGreenlightMessage } from './engine.js';

/** Registers the Greenlight parser against captured `greenlight_msg` events (design §11.7). */
export function registerGreenlightParser() {
  registerParser({
    source: 'greenlight_msg', version: 'gl-1',
    parse(db, ev) {
      const text = extractText(ev.payload);
      const out = processGreenlightMessage(db, ev.id, text, ev.received_at);
      if (out.outcome === 'unrecognized') return { status: 'unrecognized', error: out.reason };
      if (out.outcome === 'noise') return { status: 'noise' };
      return { status: 'ok' };
    },
  });
}

/** Payload is raw text, or JSON from a capture tool ({text|body|message, ...}); the webhook stores whatever arrives (D34). */
export function extractText(payload: string): string {
  const t = payload.trim();
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); return String(j.text ?? j.body ?? j.message ?? j.value1 ?? t); } catch { /* fall through */ }
  }
  return t;
}
