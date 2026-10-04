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
