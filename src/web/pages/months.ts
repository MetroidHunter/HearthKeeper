import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { pageHead } from '../ui.js';

const SHOWN = 12;
const label = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const signed = (c: number) => `${c < 0 ? '−' : '+'}${money(Math.abs(c))}`;

/** Month by month: what still needs doing in each month (with a link to do it) and a few numbers about it. No closing, no lock. */
@customElement('hk-months')
export class Months extends Page {
  @state() rows: any[] = []; @state() onlyTodo = false; @state() all = false; private toggled = new Map<string, boolean>();
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.rows = await api.get('/api/months'); }); }
  private isOpen(r: any) { return this.toggled.get(r.month) ?? r.todo > 0; }
  render() {
    const need = this.rows.filter((r) => r.todo > 0); const items = need.reduce((a, r) => a + r.todo, 0);
    const list = this.rows.filter((r) => !this.onlyTodo || r.todo > 0); const shown = this.all ? list : list.slice(0, SHOWN);
    return html`${pageHead('Months', 'Every month since your first transaction, newest first: what is left to do in it, with a link to do it, and a few numbers about how it went.', 'There is nothing to close or lock. A month is done when its list is empty, and it can reopen by itself if a late file adds something. The current month always has some things in progress.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="card row"><b class="grow" id="months-summary">${this.rows.length === 0 ? 'Loading…' : need.length === 0 ? `All ${this.rows.length} months are done.` : `${need.length} of ${this.rows.length} month${this.rows.length === 1 ? '' : 's'} ${need.length === 1 ? 'has' : 'have'} something to do (${items} item${items === 1 ? '' : 's'}).`}</b>
        <label><input type="checkbox" .checked=${this.onlyTodo} @change=${(e: any) => { this.onlyTodo = e.target.checked; }} /> Only months with something to do</label></div>
      ${repeat(shown, (r: any) => r.month, (r: any) => this.month(r))}
      ${list.length > shown.length ? html`<button @click=${() => { this.all = true; }}>Show ${list.length - shown.length} older month${list.length - shown.length === 1 ? '' : 's'}</button>` : nothing}
      ${list.length === 0 && this.rows.length ? html`<div class="card muted">Nothing to do in any month.</div>` : nothing}`;
  }
  month(r: any) {
    const s = r.stats; const done = r.todo === 0;
    return html`<details class="card month ${done ? 'done' : ''}" data-month=${r.month} ?open=${this.isOpen(r)} @toggle=${(e: Event) => this.toggled.set(r.month, (e.target as HTMLDetailsElement).open)}>
      <summary><span class="mh"><b class="mname">${label(r.month)}</b>${r.current ? html`<span class="badge">this month</span>` : nothing}
        ${done ? html`<span class="badge good">✓ nothing to do</span>` : html`<span class="badge warn">${r.todo} to do</span>`}</span>
        <span class="mstats muted"><span data-tip="Income received in the month" tabindex="0">In ${money(s.income)}</span><span data-tip="Net spending in the month (refunds reduce it)" tabindex="0">Spent ${money(s.spent)}</span>
          <span class=${s.net < 0 ? 'neg' : 'pos'} data-tip="Income minus spending" tabindex="0">${signed(s.net)}</span><span data-tip="What the budget allocated for the month" tabindex="0">plan ${money(s.planned)}</span><span>${s.txns.toLocaleString()} txns</span></span></summary>
      <div class="mbody">
        ${s.overPlan || s.top ? html`<div class="muted small">${s.top ? html`Biggest: <b>${s.top.name}</b> ${money(s.top.cents)}` : nothing}${s.overPlan ? html`${s.top ? ' · ' : ''}<a href="#/budget">${s.overPlan} envelope${s.overPlan === 1 ? '' : 's'} spent more than planned</a>` : nothing}</div>` : nothing}
        <div class="mchecks">${r.items.map((i: any) => html`<div class="mcheck ${i.count ? 'todo' : 'ok'}" data-key=${i.key}><span class="mark" aria-hidden="true">${i.count ? '⬜' : '✅'}</span>
          <span class="grow"><span class="mlabel">${i.label}</span>${i.detail ? html`<span class="muted small mdetail">${i.detail}</span>` : nothing}</span>
          ${i.count ? html`<span class="badge warn">${i.count}</span><a class="mfix" href=${i.link}>${i.key === 'coverage' ? 'Import →' : 'Fix →'}</a>` : nothing}</div>`)}</div>
      </div></details>`;
  }
}
