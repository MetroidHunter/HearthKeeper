const H = { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: H, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? r.statusText);
  return data as T;
}
export const api = {
  get: <T = any>(u: string) => req<T>('GET', u),
  post: <T = any>(u: string, b?: unknown) => queueable('POST', u, b) as Promise<T>,
  put: <T = any>(u: string, b?: unknown) => req<T>('PUT', u, b),
  patch: <T = any>(u: string, b?: unknown) => req<T>('PATCH', u, b),
};

/** Answers made offline queue and sync later (design §15.2). Only idempotent answer endpoints are queued. */
const QUEUE_KEY = 'hk-offline-queue';
function queueable(method: string, url: string, body?: unknown) {
  return req(method, url, body).catch((e) => {
    if (e instanceof ApiError || !/\/api\/transactions\/\d+\/(categorize|ignore)$/.test(url)) throw e;
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); q.push({ method, url, body }); localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return { queued: true };
  });
}
export async function flushQueue() {
  const q: { method: string; url: string; body: unknown }[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  const rest = [];
  for (const item of q) { try { await req(item.method, item.url, item.body); } catch (e) { if (!(e instanceof ApiError)) rest.push(item); } }
  localStorage.setItem(QUEUE_KEY, JSON.stringify(rest));
}
addEventListener('online', () => flushQueue());

export const money = (c: number | null | undefined, opts: { sign?: boolean } = {}) => {
  if (c === null || c === undefined) return 'N/A';
  const s = `${c < 0 ? '-' : opts.sign && c > 0 ? '+' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return s;
};
export const parseMoney = (s: string) => Math.round(parseFloat(s.replace(/[$,\s]/g, '')) * 100);
export const esc = (s: unknown) => String(s ?? '');
export const fmtDate = (d: string) => { const [y, m, day] = d.split('-'); return `${m}/${day}/${y.slice(2)}`; };
