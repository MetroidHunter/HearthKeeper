import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { thisMonth, type Cat } from '../shared.js';
import { pageHead, th, catSelect, showDialog, confirmBox } from '../ui.js';

@customElement('hk-categories')
export class Categories extends Page {
  @state() cats: any[] = []; @state() detail: any = null; @state() form = { name: '', group: '', startMonth: thisMonth(), monthly: '' };
  connectedCallback() { super.connectedCallback(); this.load(); addEventListener('hashchange', () => this.route()); }
  async load() { await this.run(async () => { this.cats = await api.get('/api/categories'); await this.route(); }); }
  async route() { const id = Number(location.hash.split('/')[2]); this.detail = id ? await api.get(`/api/categories/${id}`) : null; }
  render() {
    if (this.detail) return this.detailView();
    return html`${pageHead('Categories', 'Every envelope you can put a transaction in. Add new ones, tune how they behave when money gets tight, and retire the ones you no longer use.', 'Retiring keeps all history and sets the monthly amount to zero going forward. Unretire brings a category back with its last monthly amount. Cushion and priority control how overspending is covered during a rebalance.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card"><b>Add category</b><div class="row" style="margin-top:6px"><input placeholder="Name" @input=${(e: any) => { this.form.name = e.target.value; this.requestUpdate(); }} /><input placeholder="Group" @input=${(e: any) => { this.form.group = e.target.value; this.requestUpdate(); }} /><input type="month" .value=${this.form.startMonth} @input=${(e: any) => { this.form.startMonth = e.target.value; this.requestUpdate(); }} /><input style="width:7rem" placeholder="Monthly $" aria-label="Monthly amount" @input=${(e: any) => { this.form.monthly = e.target.value; this.requestUpdate(); }} />${(() => { const c = this.form.monthly ? parseMoney(this.form.monthly) : NaN; return Number.isFinite(c) && c > 0 ? html`<span class="muted yearly-add">= ${money(c * 12)} a year</span>` : nothing; })()}
        <button class="primary" ?disabled=${!this.form.name} @click=${async () => { await this.run(() => api.post('/api/categories', { name: this.form.name, group: this.form.group || undefined, startMonth: this.form.startMonth, monthlyCents: this.form.monthly ? parseMoney(this.form.monthly) : 0 })); this.load(); }}>Add</button></div></div>
      <div class="card" style="overflow-x:auto"><table><thead><tr>${th('Category', 'Click a name for its balance, budget history and transactions.')}${th('Group', 'Where it appears on the Budget page.')}${th('Kind', 'Expense envelopes accrue a monthly amount; income and pool categories collect money.')}${th('Discretionary', 'Discretionary envelopes are the first to give money to cover overspending.')}${th('Cushion', 'Kept ABOVE this month\'s budget when covering overspending: with a $150 budget and a $50 cushion, money is only taken from the envelope when it holds more than $200, and only the excess. Empty counts as 0: the envelope keeps exactly its budget. Discretionary envelopes give first; non-discretionary ones only afterwards, and only what is above budget + cushion.', 'num')}${th('Priority', 'When several envelopes are overspent, lower numbers are covered first.', 'num')}<th></th></tr></thead><tbody>${this.cats.filter((c) => !c.system).map((c) => html`<tr style=${c.status === 'retired' ? 'opacity:.5' : ''}><td><a href="#/categories/${c.id}" style="color:inherit;font-weight:600;text-decoration:none">${c.name}</a> ${c.status === 'retired' ? html`<span class="badge">retired</span>` : ''}</td><td>${c.group_name ?? ''}</td><td>${c.kind}</td>
        <td><input type="checkbox" .checked=${!!c.discretionary} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { discretionary: e.target.checked }); this.load(); }} /></td>
        <td class="num"><input style="width:6rem;text-align:right" .value=${c.cushion_cents == null ? '' : (c.cushion_cents / 100).toFixed(2)} placeholder="0" aria-label="Cushion above the budget" @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { cushionCents: e.target.value === '' ? null : parseMoney(e.target.value) }); this.load(); }} />${c.kind !== 'expense' ? '' : html`<div class="muted small keeps" title="Budget plus cushion (an empty cushion counts as 0)">keeps ${money(c.monthly_cents + (c.cushion_cents ?? 0))}</div>`}</td>
        <td class="num"><input style="width:3.5rem;text-align:right" .value=${c.overage_priority ?? ''} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { overagePriority: e.target.value === '' ? null : Number(e.target.value) }); this.load(); }} /></td>
        <td>${c.status === 'active' ? html`<button class="retire" @click=${() => this.retire(c)}>Retire</button>` : c.status === 'retired' && c.name.toLowerCase() !== 'needs category' ? html`<button class="unretire primary" @click=${() => this.unretire(c)}>Unretire</button>` : ''}</td></tr>`)}</tbody></table></div>`;
  }
  async retire(c: any) {
    let to: number | null = null;
    const ok = await showDialog<boolean>((close) => html`<h3 class="title">Retire ${c.name}?</h3><p class="muted">History stays. Its monthly amount drops to zero from this month. Anything left in the envelope can move to another category now, or stay put.</p>
      <label class="stack">Move the remaining balance to (optional)${catSelect(this.cats, null, (id) => (to = id), { placeholder: 'Type to search, or leave empty to keep it' })}</label>
      <div class="actions"><button @click=${() => close(false)}>Cancel</button><button class="primary danger-solid confirm" @click=${() => close(true)}>Retire</button></div>`, { dismiss: false });
    if (ok) { await this.run(() => api.post(`/api/categories/${c.id}/retire`, { moveBalanceTo: to ?? undefined })); this.load(); }
  }
  async unretire(c: any) {
    const ok = await confirmBox({ title: `Unretire ${c.name}?`, body: html`<p>It comes back as an active category with the last monthly amount it had, starting this month. Months while it was retired stay at zero.</p>`, confirm: 'Unretire' });
    if (ok) { await this.run(() => api.post(`/api/categories/${c.id}/unretire`, {})); this.load(); }
  }
  detailView() {
    const d = this.detail; const c = d.category;
    return html`<div class="row"><a href="#/categories">← Categories</a>${c.status === 'retired' && c.name.toLowerCase() !== 'needs category' ? html`<button class="unretire primary right" @click=${() => this.unretire(c)}>Unretire</button>` : nothing}</div><h1>${c.name} ${c.status === 'retired' ? html`<span class="badge">retired</span>` : nothing}</h1>
      <div class="grid2"><div class="card"><div class="muted">Balance</div><b style="font-size:22px">${money(d.balance.total)}</b><div class="muted">transactions ${money(d.balance.splits)} · transfers ${money(d.balance.transfers)} · accrued ${money(d.balance.accrued)}</div></div>
        <div class="card"><div class="muted">Budget history</div>${d.history.map((h: any) => html`<div class="row"><span>${h.effective_month}</span><span>${h.from_cents == null ? 'start' : money(h.from_cents)} → <b>${money(h.monthly_cents)}</b></span><span class="muted">${h.reason ?? ''}${h.plan_id ? ` · plan #${h.plan_id}` : ''}</span></div>`)}</div></div>
      <h2>Rules pointing here</h2><div class="card">${d.rules.length ? d.rules.map((r: any) => html`<div>${r.notes ?? `rule #${r.id}`} <span class="badge">${r.mode}</span></div>`) : html`<span class="muted">None.</span>`}</div>
      <h2>Recent transactions</h2><div class="card"><table><tbody>${d.transactions.map((t: any) => html`<tr><td>${fmtDate(t.occurred_on)}</td><td>${t.descriptor_clean || t.descriptor_raw}</td><td class="num ${t.amount_cents < 0 ? 'neg' : 'pos'}">${money(t.amount_cents)}</td></tr>`)}</tbody></table></div>`;
  }
}
export type { Cat };
