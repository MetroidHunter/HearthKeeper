import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, money } from './api.js';
import { today } from './shared.js';
import { showDialog, confirmBox, catSelect } from './ui.js';

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
export const weekLabel = (w: { from: string; to: string }) => (w.from === w.to ? day(w.from) : `${day(w.from)}–${w.from.slice(5, 7) === w.to.slice(5, 7) ? Number(w.to.slice(8)) : day(w.to)}`);
const tone = (c: number) => (c < 0 ? 'neg' : c > 0 ? 'pos' : '');

/** How full a week's bar is: spent against the money it had (its share plus what carried in). A week with nothing to spend that has spending is full. */
const fill = (w: any) => (w.availableCents > 0 ? Math.min(100, Math.max(0, (w.spentCents / w.availableCents) * 100)) : w.spentCents > 0 || w.availableCents < 0 ? 100 : 0);
/** Where today falls inside the current week, as a share of the week's width (the end of today). */
const todayAt = (w: any) => { const d = (Date.parse(today()) - Date.parse(w.from)) / 86400000 + 1; return Math.min(100, Math.max(0, (d / w.days) * 100)); };

/**
 * The month as one long bar cut into weeks (each as wide as it has days, so a short week is a short piece). Every piece is its own progress bar:
 * the dates and the week's budget above it, and what is left below it (red when the week went over) with what was spent beside it.
 */
export function weekBars(b: any) {
  return html`<div class="wkbars" role="list">${b.weeks.map((w: any) => {
    const over = w.remainingCents < 0;
    return html`<div class="wkseg ${w.state} ${over ? 'over' : ''}" role="listitem" data-week=${w.n} style="flex-grow:${w.days}" title="${weekLabel(w)}: ${money(w.remainingCents)} ${over ? 'over' : 'left'} (${money(w.availableCents)} to spend: ${money(w.allottedCents)} + ${money(w.carriedCents)} carried), ${money(w.spentCents)} spent">
      <div class="wkseg-top"><span class="wkseg-dates">${weekLabel(w)}</span><span class="wkseg-budget muted">${money(w.allottedCents)}</span></div>
      <div class="wkbar"><i style="width:${fill(w)}%"></i>${w.state === 'current' ? html`<u class="wk-now" style="left:${todayAt(w)}%" title="Today"></u>` : nothing}</div>
      <div class="wkseg-line"><b class="wkseg-left ${tone(w.remainingCents)}">${money(w.remainingCents)}</b>${w.state === 'future' && !w.spentCents ? nothing : html` <span class="wkseg-spent muted">${money(w.spentCents)}</span>`}</div>`;
  })}</div>`;
}

/** The weekly budget on the Budget page: the month's total left and the week bars. */
export function weeklyCard(b: any, on: { favorite: () => void; edit: () => void }) {
  return html`<section class="card flush wk" data-weekly=${b.id}>
    <div class="wk-head"><button class="link icon wk-fav" title=${b.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${on.favorite}>${b.favorite ? '★' : '☆'}</button>
      <h3 class="grow wk-name">${b.name}</h3>
      <span class="wk-total ${tone(b.remainingCents)}" title="The month's amount minus everything spent in it so far"><b>${money(b.remainingCents)}</b> <span class="muted small">left of ${money(b.amountCents)} this month</span></span>
      <button class="icon wk-edit" title="Edit or delete this weekly budget" aria-label="Edit weekly budget" @click=${on.edit}>✎</button></div>
    <div class="wk-bars">${weekBars(b)}</div>
  </section>`;
}

/** A Home tile: this week's money left, the whole month as little week bars, and how the month is doing. */
export function weeklyTile(b: any, on: { unfavorite: () => void }) {
  const w = b.weeks.find((x: any) => x.n === b.currentWeek) ?? b.weeks.at(-1);
  return html`<div class="fav wk-tile ${w.remainingCents < 0 ? 'over' : ''}" data-weekly=${b.id} title="${b.name}: ${weekLabel(w)} has ${money(w.availableCents)} to spend (${money(w.allottedCents)} + ${money(w.carriedCents)} carried), ${money(w.spentCents)} spent">
    <div class="fav-top"><b class="fav-name">${b.name}</b><button class="link icon" title="Remove from favorites" aria-label="Toggle favorite" @click=${on.unfavorite}>★</button></div>
    <div class="fav-bal ${tone(w.remainingCents)}">${money(w.remainingCents)}</div>
    <div class="wkbars mini">${b.weeks.map((x: any) => html`<div class="wkseg ${x.state} ${x.remainingCents < 0 ? 'over' : ''}" style="flex-grow:${x.days}"><div class="wkbar"><i style="width:${fill(x)}%"></i></div></div>`)}</div>
    <div class="fav-sub">${w.remainingCents < 0 ? 'over' : 'left'} this week (${weekLabel(w)})</div>
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
  @state() private categoryId: number | null = null; @state() private weekStart = 1;
  @state() private preview: any[] = []; @state() private err = ''; @state() private busy = false;
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    if (this.existing) { this.categoryId = this.existing.categoryId; this.weekStart = this.existing.weekStart; }
    void this.refresh();
  }
  private get monthly(): number { return this.cats.find((c) => c.id === this.categoryId)?.monthly_cents ?? 0; }
  private async refresh() {
    if (this.monthly <= 0) { this.preview = []; return; }
    this.preview = await api.get(`/api/weekly-budgets/preview?month=${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7)}&weekStart=${this.weekStart}&amountCents=${this.monthly}`).catch(() => []);
  }
  private async save() {
    this.err = '';
    if (!this.categoryId) { this.err = 'Pick a category'; return; }
    this.busy = true;
    try {
      const body = { categoryId: this.categoryId, weekStart: this.weekStart };
      if (this.existing) await api.put(`/api/weekly-budgets/${this.existing.id}`, body); else await api.post('/api/weekly-budgets', body);
      this.done(true);
    } catch (e) { this.err = (e as Error).message; } finally { this.busy = false; }
  }
  private async deleteIt() {
    if (!(await confirmBox({ title: 'Delete this weekly budget?', body: `"${this.existing.name}" goes away, along with its Home pin. The ${this.existing.category} budget and your transactions are not affected.`, confirm: 'Delete', danger: true }))) return;
    this.busy = true;
    try { await api.del(`/api/weekly-budgets/${this.existing.id}`); this.done(true); } catch (e) { this.err = (e as Error).message; } finally { this.busy = false; }
  }
  render() {
    const name = this.cats.find((c) => c.id === this.categoryId)?.name;
    return html`<h3 class="title">${this.existing ? 'Edit weekly budget' : 'New weekly budget'}</h3>
      <div class="stack">
        <div class="row">${catSelect(this.cats, this.categoryId, (id) => { this.categoryId = id; void this.refresh(); }, { placeholder: 'Category (type to search)' })}
          <label>Weeks start on <select aria-label="Week starts on" @change=${(e: any) => { this.weekStart = Number(e.target.value); void this.refresh(); }}>${DAYS.slice(1).map((d, i) => html`<option value=${i + 1} ?selected=${this.weekStart === i + 1}>${d}</option>`)}</select></label></div>
        ${name ? html`<p class="muted wk-total-line" style="margin:0">It will be called <b>${name} Weekly</b> and spreads the ${name} budget, <b>${money(this.monthly)}</b> a month, over the weeks. To change the amount, change the category's budget.</p>` : html`<p class="muted" style="margin:0">Pick the category to spread over the weeks of the month. Its monthly budget is the total.</p>`}
        ${this.preview.length ? html`<div class="wk-preview"><b>This month's weeks</b> <span class="muted small">(each gets its share by days; the first and last weeks of a month can be short)</span>
          <table class="wk-table"><thead><tr><th>Week</th><th class="num">Budget</th><th class="num">Limit by week end</th></tr></thead><tbody>${this.preview.map((w) => html`<tr><td>${weekLabel(w)} <span class="muted small">${w.days} day${w.days === 1 ? '' : 's'}</span></td><td class="num">${money(w.allottedCents)}</td><td class="num muted">${money(w.limitCents)}</td></tr>`)}</tbody></table></div>` : nothing}
        ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      </div>
      <div class="actions">${this.existing ? html`<button class="danger wk-delete" ?disabled=${this.busy} @click=${() => this.deleteIt()}>Delete</button><span class="grow"></span>` : nothing}
        <button class="cancel" @click=${() => this.done(false)}>Cancel</button><button class="primary wk-save" ?disabled=${this.busy} @click=${() => this.save()}>Save</button></div>`;
  }
}
