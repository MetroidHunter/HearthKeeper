import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { catOptions, amt, pace, type Cat } from '../shared.js';

/** Phone home (design §15.1): Needs you, Favorites, Recent, Quick add, Search. */
@customElement('hk-home')
export class Home extends Page {
  @state() inbox: any = null; @state() budget: any = null; @state() recent: any[] = []; @state() cats: Cat[] = []; @state() q = ''; @state() add = false;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() {
    await this.run(async () => {
      [this.inbox, this.budget, this.recent, this.cats, this.accounts] = await Promise.all([api.get('/api/inbox'), api.get('/api/budget'), api.get('/api/transactions?limit=20'), api.get('/api/categories'), api.get('/api/accounts')]);
    });
  }
  async answer(id: number, categoryId: number, makeRule?: string) { await this.run(() => api.post(`/api/transactions/${id}/categorize`, { categoryId, makeRule })); this.load(); }
  @state() accounts: any[] = [];
  render() {
    if (!this.inbox) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const needs = [...this.inbox.needsCategory, ...this.inbox.needsNote, ...this.inbox.staleProvisionals, ...this.inbox.flagged].filter((t: any, i, a) => a.findIndex((x: any) => x.id === t.id) === i);
    const favs = (this.budget?.rows ?? []).filter((r: any) => r.favorite).slice(0, 8);
    const top = favs.length ? favs : (this.budget?.rows ?? []).filter((r: any) => r.kind === 'expense').slice(0, 6);
    return html`
      <h1>Home</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><input class="grow" type="search" placeholder="Search merchant, note, category" .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && (location.hash = `#/explore?q=${encodeURIComponent(this.q)}`)} />
        <button class="primary" @click=${() => (this.add = true)}>＋ Add</button></div>
      <h2>Needs you (${needs.length}${this.inbox.greenlightRequests.length ? ` + ${this.inbox.greenlightRequests.length} Greenlight` : ''})</h2>
      ${needs.length === 0 ? html`<div class="card muted">All caught up.</div>` : needs.slice(0, 15).map((t: any) => this.needsCard(t))}
      ${this.inbox.greenlightRequests.map((r: any) => html`<div class="card row"><div class="grow"><b>${r.display_name}</b> requests ${money(r.amount_cents)}</div>
        <a href="#/greenlight"><button>Review</button></a></div>`)}
      <h2>Favorites</h2>
      <div class="grid2">${top.map((r: any) => html`<div class="card"><div class="row"><b class="grow">${r.name}</b><span class="mono ${r.currentCents < 0 ? 'neg' : ''}">${money(r.currentCents)}</span></div>
        <div class="bar ${r.currentCents < 0 ? 'over' : ''}" style="margin-top:6px"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div>
        <div class="muted">Spent ${money(r.spent[0])} of ${money(r.targetCents)}</div></div>`)}</div>
      <h2>Recent</h2>
      <div class="card">${this.recent.map((t: any) => html`<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)"><span class="muted">${fmtDate(t.occurred_on)}</span>
        <span class="grow">${t.descriptor_clean || t.descriptor_raw} ${t.status === 'provisional' ? html`<span class="badge warn">pending</span>` : ''}</span>
        <span class="muted hide-sm">${t.splits[0]?.category ?? ''}</span>${amt(t.amount_cents)}</div>`)}</div>
      ${this.add ? this.addDialog() : ''}`;
  }
  needsCard(t: any) {
    const picks = t.suggestions ?? [];
    return html`<div class="card"><div class="row"><b class="grow">${t.descriptor_clean || t.descriptor_raw}</b>${amt(t.amount_cents)}</div>
      <div class="muted">${fmtDate(t.occurred_on)} · ${t.account}${t.note_state && t.note_state !== 'not_needed' ? ` · note: ${t.note_state}` : ''}${t.flag_reason ? ` · ${t.flag_reason}` : ''}</div>
      <div class="row" style="margin-top:8px">${picks.map((p: any, i: number) => html`<button class=${i === 0 ? 'chip primary' : 'chip'} title=${p.why} @click=${() => this.answer(t.id, p.id, i === 0 && p.why !== 'rule' ? 'suggest' : undefined)}>${p.name}${i === 0 ? ' ✓' : ''}</button>`)}
        <select @change=${(e: any) => e.target.value && this.answer(t.id, Number(e.target.value))}>${catOptions(this.cats, null, { blank: 'More…' })}</select>
        <button @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'not a budget item' })); this.load(); }}>Not a budget item</button></div></div>`;
  }
  addDialog() {
    let desc = '', cents = 0, cat = 0, account = this.accounts[0]?.id ?? 1;
    return html`<dialog open><h2 style="margin-top:0">Quick add</h2>
      <div class="row"><input class="grow" placeholder="What was it?" @input=${(e: any) => (desc = e.target.value)} /><input style="width:7rem" inputmode="decimal" placeholder="12.50" @input=${(e: any) => (cents = -Math.round(parseFloat(e.target.value || '0') * 100))} /></div>
      <div class="row" style="margin-top:8px"><select class="grow" @change=${(e: any) => (cat = Number(e.target.value))}>${catOptions(this.cats, null, { blank: 'Category' })}</select>
        <select @change=${(e: any) => (account = Number(e.target.value))}>${this.accounts.map((a: any) => html`<option value=${a.id}>${a.name}</option>`)}</select></div>
      <div class="row" style="margin-top:12px"><button @click=${() => (this.add = false)}>Cancel</button>
        <button class="primary" @click=${async () => { await this.run(() => api.post('/api/transactions', { accountId: account, descriptor: desc || 'Manual entry', amountCents: cents, categoryId: cat || undefined })); this.add = false; this.load(); }}>Save</button></div></dialog>`;
  }
}
