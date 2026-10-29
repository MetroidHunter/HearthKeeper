import { html } from 'lit';

/**
 * Back and scroll memory for the hash router. Every entry in the browser history is tagged `{ hk, i }` (an id and its depth in this visit),
 * so Back can tell whether there is an earlier page of the app to return to, and each entry remembers how far down the page it was scrolled.
 * Going Back (the Back links, the browser's button, a phone's back gesture) returns to that scroll position once the page has filled in.
 */
type Entry = { hk: string; i: number };
const KEY = 'hk-scroll';
let cur: Entry = { hk: '', i: 0 };
let started = false;
let restoring: (() => void) | null = null; // cancels a restore in progress

const saved = (): Record<string, number> => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };
const remember = (id: string, y: number) => { try { const s = saved(); s[id] = Math.round(y); sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* optional: Back still works, it just lands at the top */ } };
const tag = (i: number): Entry => { const e = { hk: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, i }; history.replaceState(e, ''); return e; };
const jump = (y: number) => scrollTo({ top: y, left: 0, behavior: 'instant' });

/** Go to `y`, retrying while the page below is still loading and too short to scroll that far; any touch of the page by the person cancels it. */
function restore(y: number) {
  restoring?.();
  if (y <= 0) { jump(0); return; }
  const stop = () => { clearTimeout(timer); cancelAnimationFrame(raf); for (const ev of INPUTS) removeEventListener(ev, stop, true); restoring = null; };
  const t0 = Date.now(); let raf = 0, timer: any;
  const tick = () => { jump(y); if (Math.abs(scrollY - y) < 2 || Date.now() - t0 > 4000) return stop(); raf = requestAnimationFrame(tick); };
  for (const ev of INPUTS) addEventListener(ev, stop, { capture: true, passive: true, once: true });
  restoring = stop; tick();
}
const INPUTS = ['wheel', 'touchstart', 'keydown', 'mousedown'];

/** Call when the app starts. Safe to repeat: it re-reads the current history entry and listens only once. */
export function initNav() {
  const s = history.state as Entry | null;
  cur = s && typeof s.hk === 'string' ? s : tag(0); // a reload keeps its entry (and so its depth); a first visit starts at 0
  if (started) return; started = true;
  try { history.scrollRestoration = 'manual'; } catch { /* the browser's own restore will do what it can */ }
  addEventListener('scroll', () => { if (!restoring) remember(cur.hk, scrollY); }, { passive: true });
  addEventListener('hashchange', () => {
    document.querySelectorAll('dialog[open]:not(.busy)').forEach((d) => (d as HTMLDialogElement).close()); // a dialog belongs to the page it was opened on
    const s = history.state as Entry | null;
    if (s && typeof s.hk === 'string') { cur = s; restore(saved()[s.hk] ?? 0); } // Back / Forward: return to where that page was left
    else { restoring?.(); cur = tag(cur.i + 1); jump(0); } // a link or a typed address: a new page starts at the top
  });
}

/** Is there an earlier page of the app to go back to? */
export const canGoBack = () => cur.i > 0;
/** Back to the page we came from; when this one was opened directly, to `fallback`. */
export function goBack(fallback: string) { if (canGoBack()) history.back(); else location.hash = `#${fallback}`; }

/** A "← Back" link. It is a real link to `fallback` (middle-click, copy address), but a plain click goes back in history. */
export const backLink = (fallback: string, label = 'Back') => html`<a class="back" href="#${fallback}" @click=${(e: MouseEvent) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !canGoBack()) return; e.preventDefault(); history.back(); }}>← ${label}</a>`;
