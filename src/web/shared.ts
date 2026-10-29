import { html } from 'lit';
import { money } from './api.js';

export interface Cat { id: number; name: string; group_name?: string | null; status: string; kind: string }

export function catOptions(cats: Cat[], selected?: number | null, opts: { includeRetired?: boolean; blank?: string } = {}) {
  const groups = new Map<string, Cat[]>();
  for (const c of cats) { if (c.status !== 'active' && !opts.includeRetired) continue; const g = c.group_name ?? 'Other'; (groups.get(g) ?? groups.set(g, []).get(g)!).push(c); }
  return html`${opts.blank !== undefined ? html`<option value="">${opts.blank}</option>` : ''}${[...groups].map(([g, list]) => html`<optgroup label=${g}>${list.map((c) => html`<option value=${c.id} ?selected=${c.id === selected}>${c.name}</option>`)}</optgroup>`)}`;
}
export const amt = (c: number) => html`<span class="mono ${c < 0 ? 'neg' : c > 0 ? 'pos' : ''}">${money(c)}</span>`;
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
export const thisMonth = () => today().slice(0, 7);
export function pace(spent: number, target: number) { return target > 0 ? Math.min(100, Math.max(0, (spent / target) * 100)) : spent > 0 ? 100 : 0; }

/** Where this month's spending stands against an even pace: how far into the month it is, what an even pace would have spent by now, and where today's rate ends up. */
export function monthPace(spent: number, target: number, todayIso: string) {
  const [y, m, d] = todayIso.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate(), day = Math.min(d, days);
  const expected = Math.round((target * day) / days);
  return { day, days, expected, delta: spent - expected, projected: Math.round((spent / day) * days) };
}

/** A rule's condition in words, e.g. `descriptor contains "TRADER JOE" AND amount ≥ $20.00`. */
export function ruleSummary(r: { match_json: string }): string {
  const usd = (n: number) => `$${(n / 100).toFixed(2)}`;
  const one = (c: any) => c.field === 'amount_abs' ? `amount ${({ eq: 'is', gte: '≥', lte: '≤', between: 'between' } as any)[c.op] ?? c.op} ${c.op === 'between' ? `${usd(c.value[0])} and ${usd(c.value[1])}` : usd(c.value)}`
    : `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
  try { return JSON.parse(r.match_json).all_of.map((c: any) => (c.any_of ? `(${c.any_of.map(one).join(' OR ')})` : one(c))).join(' AND '); } catch { return ''; }
}
