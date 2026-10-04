import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { catOptions, type Cat } from '../shared.js';

@customElement('hk-greenlight')
export class Greenlight extends Page {
  @state() d: any = null; @state() cats: Cat[] = []; @state() newReq = { profileId: 0, amount: '' }; @state() chosen: Record<number, number> = {};
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.d, this.cats] = await Promise.all([api.get('/api/greenlight'), api.get('/api/categories')]); }); }
  render() {
    const d = this.d; if (!d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    return html`<h1>Greenlight</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card row"><div class="grow"><div class="muted">Wallet balance (funding − allowances + returns)</div><b>${money(d.walletBalanceCents)}</b></div>
        ${d.missingAllowances.length ? html`<span class="badge bad">${d.missingAllowances.length} expected allowance(s) missing</span>` : html`<span class="badge">no gaps</span>`}</div>
      <h2>Profiles &amp; policies</h2>
      <div class="grid2">${d.profiles.map((p: any) => html`<div class="card"><b>${p.display_name}</b> <span class="muted">→ ${p.category}</span>
        <div class="row" style="margin-top:6px"><label class="muted">Spends <select @change=${async (e: any) => { await api.patch(`/api/greenlight/profiles/${p.id}`, { spendPolicy: e.target.value }); this.load(); }}>${['ignore', 'reclassify'].map((v) => html`<option ?selected=${v === p.spend_policy}>${v}</option>`)}</select></label>
          <label class="muted">Requests <select @change=${async (e: any) => { await api.patch(`/api/greenlight/profiles/${p.id}`, { requestPolicy: e.target.value }); this.load(); }}>${['as_allowance', 'ask_category'].map((v) => html`<option ?selected=${v === p.request_policy}>${v}</option>`)}</select></label></div></div>`)}</div>
      <h2>Requests</h2>
      <div class="card"><div class="row"><select @change=${(e: any) => (this.newReq.profileId = Number(e.target.value))}><option value="">Profile</option>${d.profiles.map((p: any) => html`<option value=${p.id}>${p.display_name}</option>`)}</select>
        <input style="width:7rem" placeholder="Amount" @input=${(e: any) => (this.newReq.amount = e.target.value)} /><button @click=${async () => { await this.run(() => api.post('/api/greenlight/requests', { profileId: this.newReq.profileId, amountCents: parseMoney(this.newReq.amount) })); this.load(); }}>Record request</button>
        <span class="muted">A request never posts a charge by itself; approving it books the money movement.</span></div>
        ${d.requests.map((r: any) => { const p = d.profiles.find((x: any) => x.id === r.profile_id); return html`<div class="row" style="margin-top:8px"><b>${p?.display_name}</b><span>${money(r.amount_cents)}</span><span class="badge">${r.status}</span>
          ${r.status === 'pending' ? html`${p?.request_policy === 'ask_category' ? html`<select @change=${(e: any) => (this.chosen[r.id] = Number(e.target.value))}>${catOptions(this.cats, null, { blank: 'Which category pays?' })}</select>` : ''}
            <button class="primary" @click=${async () => { await this.run(() => api.post(`/api/greenlight/requests/${r.id}/approve`, { categoryId: this.chosen[r.id] })); this.load(); }}>Approved</button>
            <button @click=${async () => { await api.post(`/api/greenlight/requests/${r.id}/decline`); this.load(); }}>Declined</button>` : ''}</div>`; })}</div>
      <h2>Unrecognized messages</h2>
      <div class="card">${d.unrecognized.length === 0 ? html`<span class="muted">None.</span>` : d.unrecognized.map((u: any) => html`<div style="padding:4px 0;border-bottom:1px solid var(--line)"><div class="muted">${u.received_at}</div>${u.payload}</div>`)}</div>`;
  }
}
