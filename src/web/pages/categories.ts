import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { thisMonth, type Cat } from '../shared.js';

@customElement('hk-categories')
export class Categories extends Page {
  @state() cats: any[] = []; @state() detail: any = null; @state() form = { name: '', group: '', startMonth: thisMonth(), monthly: '' };
  connectedCallback() { super.connectedCallback(); this.load(); addEventListener('hashchange', () => this.route()); }
  async load() { await this.run(async () => { this.cats = await api.get('/api/categories'); await this.route(); }); }
  async route() { const id = Number(location.hash.split('/')[2]); this.detail = id ? await api.get(`/api/categories/${id}`) : null; }
  render() {
    if (this.detail) return this.detailView();
    return html`<h1>Categories</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card"><b>Add category</b><div class="row" style="margin-top:6px"><input placeholder="Name" @input=${(e: any) => (this.form.name = e.target.value)} /><input placeholder="Group" @input=${(e: any) => (this.form.group = e.target.value)} /><input type="month" .value=${this.form.startMonth} @input=${(e: any) => (this.form.startMonth = e.target.value)} /><input style="width:7rem" placeholder="Monthly $" @input=${(e: any) => (this.form.monthly = e.target.value)} />
        <button class="primary" ?disabled=${!this.form.name} @click=${async () => { await this.run(() => api.post('/api/categories', { name: this.form.name, group: this.form.group || undefined, startMonth: this.form.startMonth, monthlyCents: this.form.monthly ? parseMoney(this.form.monthly) : 0 })); this.load(); }}>Add</button></div></div>
      <div class="card" style="overflow-x:auto"><table><thead><tr><th>Category</th><th>Group</th><th>Kind</th><th>Discretionary</th><th class="num">Cushion</th><th class="num">Priority</th><th></th></tr></thead><tbody>${this.cats.map((c) => html`<tr style=${c.status === 'retired' ? 'opacity:.5' : ''}><td><a href="#/categories/${c.id}">${c.name}</a> ${c.status === 'retired' ? html`<span class="badge">retired</span>` : ''}</td><td>${c.group_name ?? ''}</td><td>${c.kind}</td>
        <td><input type="checkbox" .checked=${!!c.discretionary} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { discretionary: e.target.checked }); this.load(); }} /></td>
        <td class="num"><input style="width:6rem;text-align:right" .value=${c.cushion_cents == null ? '' : (c.cushion_cents / 100).toFixed(2)} placeholder="—" @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { cushionCents: e.target.value === '' ? null : parseMoney(e.target.value) }); this.load(); }} /></td>
        <td class="num"><input style="width:3.5rem;text-align:right" .value=${c.overage_priority ?? ''} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { overagePriority: e.target.value === '' ? null : Number(e.target.value) }); this.load(); }} /></td>
        <td>${c.status === 'active' ? html`<button @click=${async () => { const to = prompt('Retire this category. Move any remaining balance to which category id? (blank = keep)'); await this.run(() => api.post(`/api/categories/${c.id}/retire`, { moveBalanceTo: to ? Number(to) : undefined })); this.load(); }}>Retire</button>` : ''}</td></tr>`)}</tbody></table></div>`;
  }
  detailView() {
    const d = this.detail; const c = d.category;
    return html`<p><a href="#/categories">← Categories</a></p><h1>${c.name}</h1>
      <div class="grid2"><div class="card"><div class="muted">Balance</div><b style="font-size:22px">${money(d.balance.total)}</b><div class="muted">transactions ${money(d.balance.splits)} · transfers ${money(d.balance.transfers)} · accrued ${money(d.balance.accrued)}</div></div>
        <div class="card"><div class="muted">Budget history</div>${d.history.map((h: any) => html`<div class="row"><span>${h.effective_month}</span><span>${h.from_cents == null ? 'start' : money(h.from_cents)} → <b>${money(h.monthly_cents)}</b></span><span class="muted">${h.reason ?? ''}${h.plan_id ? ` · plan #${h.plan_id}` : ''}</span></div>`)}</div></div>
      <h2>Rules pointing here</h2><div class="card">${d.rules.length ? d.rules.map((r: any) => html`<div>${r.notes ?? `rule #${r.id}`} <span class="badge">${r.mode}</span></div>`) : html`<span class="muted">None.</span>`}</div>
      <h2>Recent transactions</h2><div class="card"><table><tbody>${d.transactions.map((t: any) => html`<tr><td>${fmtDate(t.occurred_on)}</td><td>${t.descriptor_clean || t.descriptor_raw}</td><td class="num ${t.amount_cents < 0 ? 'neg' : 'pos'}">${money(t.amount_cents)}</td></tr>`)}</tbody></table></div>`;
  }
}
export type { Cat };
