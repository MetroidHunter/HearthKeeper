import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, money, parseMoney } from './api.js';
import { pace } from './shared.js';
import { showDialog, confirmBox } from './ui.js';

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
export const weekLabel = (w: { from: string; to: string }) => (w.from === w.to ? day(w.from) : `${day(w.from)} – ${w.from.slice(5, 7) === w.to.slice(5, 7) ? Number(w.to.slice(8)) : day(w.to)}`);
const tone = (c: number) => (c < 0 ? 'neg' : c > 0 ? 'pos' : '');

/** The weekly budget on the Budget page: the month's total left, then each week (its share, what carried in, what was spent, what is left). */
export function weeklyCard(b: any, on: { favorite: () => void; edit: () => void }) {
  return html`<section class="card flush wk" data-weekly=${b.id}>
    <div class="wk-head"><button class="link icon wk-fav" title=${b.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${on.favorite}>${b.favorite ? '★' : '☆'}</button>
      <h3 class="grow wk-name">${b.name}</h3>
      <span class="wk-total ${tone(b.remainingCents)}" title="The month's amount minus everything spent in it so far"><b>${money(b.remainingCents)}</b> <span class="muted small">left of ${money(b.amountCents)} this month</span></span>
      <button class="icon wk-edit" title="Edit or delete this weekly budget" aria-label="Edit weekly budget" @click=${on.edit}>✎</button></div>
    <div class="muted small wk-sub">Counts ${b.categories.join(', ')} · weeks start ${DAYS[b.weekStart]} · what is left in a week rolls into the next, and a week that goes over eats into it</div>
    <div style="overflow-x:auto"><table class="wk-table"><thead><tr><th>Week</th><th class="num">Budget</th><th class="num">Carried in</th><th class="num">Spent</th><th class="num">Left</th><th class="num hide-sm" title="The most you can have spent by the end of this week to be on track for the month">Limit by week end</th></tr></thead>
      <tbody>${b.weeks.map((w: any) => html`<tr class="wk-row ${w.state}" data-week=${w.n}>
        <td>${weekLabel(w)} <span class="muted small">${w.days} day${w.days === 1 ? '' : 's'}</span>${w.state === 'current' ? html` <span class="badge good">this week</span>` : nothing}</td>
        <td class="num">${money(w.allottedCents)}</td><td class="num ${tone(w.carriedCents)}">${w.carriedCents ? money(w.carriedCents) : '–'}</td><td class="num">${money(w.spentCents)}</td>
        <td class="num wk-left ${tone(w.remainingCents)}"><b>${money(w.remainingCents)}</b></td><td class="num muted hide-sm">${money(w.limitCents)}</td></tr>`)}</tbody></table></div>
  </section>`;
}

/** A Home tile: this week's money left, the week's dates, and how the month is doing. */
export function weeklyTile(b: any, on: { unfavorite: () => void }) {
  const w = b.weeks.find((x: any) => x.n === b.currentWeek) ?? b.weeks.at(-1);
  return html`<div class="fav wk-tile ${w.remainingCents < 0 ? 'over' : ''}" data-weekly=${b.id} title="${b.name}: ${weekLabel(w)} has ${money(w.availableCents)} to spend (${money(w.allottedCents)} + ${money(w.carriedCents)} carried), ${money(w.spentCents)} spent">
    <div class="fav-top"><b class="fav-name">${b.name}</b><span class="badge wk-badge">week</span><button class="link icon" title="Remove from favorites" aria-label="Toggle favorite" @click=${on.unfavorite}>★</button></div>
    <div class="fav-bal ${tone(w.remainingCents)}">${money(w.remainingCents)}</div>
    <div class="bar ${w.remainingCents < 0 ? 'over' : ''}"><i style="width:${pace(w.spentCents, w.availableCents)}%"></i></div>
    <div class="fav-sub">${weekLabel(w)} · ${money(w.spentCents)} of ${money(w.availableCents)}</div>
    <div class="fav-sub wk-month ${tone(b.remainingCents)}">Month: ${money(b.remainingCents)} left of ${money(b.amountCents)}</div></div>`;
}

/** Create or edit a weekly budget (with a delete button when editing). Resolves true when something changed. */
export async function weeklyDialog(existing?: any): Promise<boolean> {
  const cats: any[] = (await api.get('/api/categories')).filter((c: any) => c.status === 'active' && c.kind === 'expense');
  return (await showDialog<boolean>((close) => html`<hk-weekly-form .cats=${cats} .existing=${existing} .done=${close}></hk-weekly-form>`, { dismiss: false })) === true;
}

@customElement('hk-weekly-form')
export class WeeklyForm extends LitElement {
  @property({ attribute: false }) cats: any[] = [];
  @property({ attribute: false }) existing: any = null;
  @property({ attribute: false }) done: (changed?: boolean) => void = () => {};
  @state() private name = ''; @state() private amount = ''; @state() private picked = new Set<number>(); @state() private weekStart = 1;
  @state() private preview: any[] = []; @state() private err = ''; @state() private busy = false;
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    const e = this.existing;
    if (e) { this.name = e.name; this.amount = (e.amountCents / 100).toFixed(2); this.picked = new Set(e.categoryIds); this.weekStart = e.weekStart; }
    void this.refresh();
  }
  private async refresh() {
    const cents = parseMoney(this.amount || '');
    if (!Number.isFinite(cents) || cents <= 0) { this.preview = []; return; }
    this.preview = await api.get(`/api/weekly-budgets/preview?month=${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7)}&weekStart=${this.weekStart}&amountCents=${cents}`).catch(() => []);
  }
  private async save() {
    this.err = '';
    const amountCents = parseMoney(this.amount || '');
    if (!Number.isFinite(amountCents)) { this.err = 'Enter the monthly amount, like 300.00'; return; }
    this.busy = true;
    try {
      const body = { name: this.name, amountCents, categoryIds: [...this.picked], weekStart: this.weekStart };
      if (this.existing) await api.put(`/api/weekly-budgets/${this.existing.id}`, body); else await api.post('/api/weekly-budgets', body);
      this.done(true);
    } catch (e) { this.err = (e as Error).message; } finally { this.busy = false; }
  }
  private async deleteIt() {
    if (!(await confirmBox({ title: 'Delete this weekly budget?', body: `"${this.existing.name}" goes away, along with its Home pin. Your transactions are not affected.`, confirm: 'Delete', danger: true }))) return;
    this.busy = true;
    try { await api.del(`/api/weekly-budgets/${this.existing.id}`); this.done(true); } catch (e) { this.err = (e as Error).message; } finally { this.busy = false; }
  }
  render() {
    const groups = new Map<string, any[]>();
    for (const c of this.cats) (groups.get(c.group_name ?? 'Other') ?? groups.set(c.group_name ?? 'Other', []).get(c.group_name ?? 'Other')!).push(c);
    return html`<h3 class="title">${this.existing ? 'Edit weekly budget' : 'New weekly budget'}</h3>
      <div class="stack">
        <div class="row"><input class="grow" aria-label="Name" placeholder="Name, like Eating out" .value=${this.name} @input=${(e: any) => (this.name = e.target.value)} />
          <input style="width:8rem" inputmode="decimal" aria-label="Monthly amount" placeholder="300.00" .value=${this.amount} @input=${(e: any) => { this.amount = e.target.value; void this.refresh(); }} /><span class="muted">a month</span></div>
        <div class="row"><label>Weeks start on <select aria-label="Week starts on" @change=${(e: any) => { this.weekStart = Number(e.target.value); void this.refresh(); }}>${DAYS.slice(1).map((d, i) => html`<option value=${i + 1} ?selected=${this.weekStart === i + 1}>${d}</option>`)}</select></label></div>
        <div><b>Spending that counts</b> <span class="muted small">(${this.picked.size} chosen)</span>
          <div class="wk-cats">${[...groups].map(([g, list]) => html`<div class="wk-catgroup"><span class="muted small">${g}</span>${list.map((c) => html`<label class="row" style="gap:6px"><input type="checkbox" data-cat=${c.id} .checked=${this.picked.has(c.id)} @change=${(e: any) => { const s = new Set(this.picked); if (e.target.checked) s.add(c.id); else s.delete(c.id); this.picked = s; }} /> ${c.name}</label>`)}</div>`)}</div></div>
        ${this.preview.length ? html`<div class="wk-preview"><b>This month's weeks</b> <span class="muted small">(each gets its share by days; the last week of the month can be short, and so can the first)</span>
          <table class="wk-table"><thead><tr><th>Week</th><th class="num">Budget</th><th class="num">Limit by week end</th></tr></thead><tbody>${this.preview.map((w) => html`<tr><td>${weekLabel(w)} <span class="muted small">${w.days} day${w.days === 1 ? '' : 's'}</span></td><td class="num">${money(w.allottedCents)}</td><td class="num muted">${money(w.limitCents)}</td></tr>`)}</tbody></table></div>` : nothing}
        ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      </div>
      <div class="actions">${this.existing ? html`<button class="danger wk-delete" ?disabled=${this.busy} @click=${() => this.deleteIt()}>Delete</button><span class="grow"></span>` : nothing}
        <button class="cancel" @click=${() => this.done(false)}>Cancel</button><button class="primary wk-save" ?disabled=${this.busy} @click=${() => this.save()}>Save</button></div>`;
  }
}
