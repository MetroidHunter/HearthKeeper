import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { thisMonth } from '../shared.js';
import { pageHead, th } from '../ui.js';

@customElement('hk-plans')
export class Plans extends Page {
  @state() plans: any[] = []; @state() scenarios: any[] = []; @state() cur: any = null; @state() diff: any = null; @state() month = thisMonth(); @state() confirmText = '';
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.plans, this.scenarios] = await Promise.all([api.get('/api/plans'), api.get('/api/scenarios')]); if (this.cur) this.cur = await api.get(`/api/plans/${this.cur.plan.id}`); }); }
  async open(id: number) { await this.run(async () => { this.cur = await api.get(`/api/plans/${id}`); this.diff = null; }); }
  async create(from: string, fromPlanId?: number) { const name = prompt('Plan name?', 'New plan'); if (!name) return; await this.run(async () => { const r = await api.post('/api/plans', { name, from, fromPlanId }); await this.load(); await this.open(r.id); }); }
  async setItem(catId: number, v: string) { await this.run(() => api.put(`/api/plans/${this.cur.plan.id}/items/${catId}`, { monthlyCents: parseMoney(v) })); await this.load(); }
  async showDiff() { await this.run(async () => { this.diff = await api.get(`/api/plans/${this.cur.plan.id}/diff?month=${this.month}`); this.confirmText = ''; }); }
  async go() { await this.run(async () => { await api.post(`/api/plans/${this.cur.plan.id}/make-live`, { effectiveMonth: this.month, confirmRestate: this.confirmText }); this.diff = null; await this.load(); }); }
  render() {
    const c = this.cur;
    return html`${pageHead('Plans', 'A plan is a complete monthly budget you can draft safely and then make live. Changing a monthly amount for one category is done on the Budget page; plans are for changing many at once.', 'Before a plan goes live you see exactly which categories change and by how much. Going live starts a new budget version from the month you choose; going live for a past month restates history and asks you to confirm.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><button class="primary" @click=${() => this.create('live')}>＋ New from live</button><button @click=${() => this.create('blank')}>＋ Blank</button></div>
      <div class="grid2"><div>${this.plans.map((p) => html`<div class="card row" style="cursor:pointer" @click=${() => this.open(p.id)}><div class="grow"><b>${p.name}</b> <span class="badge ${p.status === 'live' ? '' : 'warn'}">${p.status}</span>
        <div class="muted">${money(p.allocatedCents)} of ${money(p.incomeCents)} · unallocated <span class=${p.unallocatedCents < 0 ? 'neg' : ''}>${money(p.unallocatedCents)}</span></div></div>
        ${p.status !== 'draft' ? html`<button @click=${(e: Event) => { e.stopPropagation(); this.create('plan', p.id); }}>Clone</button>` : ''}</div>`)}</div>
      <div>${c ? html`<div class="card"><div class="row"><b class="grow">${c.plan.name}</b><span class="badge">${c.plan.status}</span></div>
        <div class="row" style="margin:8px 0"><label class="muted">Earnings</label><select ?disabled=${c.plan.status !== 'draft'} @change=${async (e: any) => { await this.run(() => api.put(`/api/plans/${c.plan.id}/scenario`, { scenarioId: Number(e.target.value) || null })); this.load(); }}>
          <option value="">none</option>${this.scenarios.map((s) => html`<option value=${s.id} ?selected=${s.id === c.plan.scenario_id}>${s.name} (${money(s.monthlyNetCents)}/mo)</option>`)}</select></div>
        <div class="row"><span>Income <b>${money(c.header.incomeCents)}</b></span><span>− allocated <b>${money(c.header.allocatedCents)}</b></span><span>= unallocated <b class=${c.header.unallocatedCents < 0 ? 'neg' : ''}>${money(c.header.unallocatedCents)}</b></span></div>
        ${c.header.overAllocated ? html`<div class="badge bad">Over-allocated (warning only)</div>` : ''}
        <table style="margin-top:8px"><tbody>${c.items.map((i: any) => html`<tr><td>${i.name}</td><td class="num"><input style="width:7rem;text-align:right" .value=${(i.monthly_cents / 100).toFixed(2)} ?disabled=${c.plan.status !== 'draft'} @change=${(e: any) => this.setItem(i.category_id, e.target.value)} /></td><td class="num muted small yearly">${i.monthly_cents ? `${money(i.monthly_cents * 12)} a year` : ''}</td></tr>`)}</tbody></table>
        ${c.plan.status !== 'live' ? html`<div class="row" style="margin-top:10px"><input type="month" .value=${this.month} @change=${(e: any) => (this.month = e.target.value)} /><button class="primary" @click=${() => this.showDiff()}>Make live…</button></div>` : ''}</div>` : html`<div class="card muted">Pick or create a plan.</div>`}</div></div>
      ${this.diff ? this.confirmDialog() : ''}`;
  }
  confirmDialog() {
    const d = this.diff;
    return html`<dialog open><h2 style="margin-top:0">Make live</h2>
      ${d.staleBase ? html`<p class="badge warn">Live changed after this draft was created; diff is against current live.</p>` : ''}
      <p>Income ${d.incomeOld === null ? '—' : money(d.incomeOld)} → <b>${money(d.incomeNew)}</b>. Allocated ${money(d.allocatedOld)} → ${money(d.allocatedNew)} (unallocated ${money(d.unallocatedNew)}). Effective <b>${d.effectiveMonth}</b>.</p>
      <p><b>${d.historyEntries}</b> history ${d.historyEntries === 1 ? 'entry' : 'entries'} will be created.</p>
      <table><thead><tr>${th('Category', 'A category whose monthly amount changes.')}${th('Old', 'Monthly amount before this plan.', 'num')}${th('New', 'Monthly amount if you go live.', 'num')}${th('Δ', 'New minus old.', 'num')}${d.retroactive ? th('Balance Δ', 'How much this category\'s current balance changes because past months are restated.', 'num') : ''}</tr></thead><tbody>
        ${d.rows.map((r: any) => html`<tr><td>${r.name}</td><td class="num">${money(r.oldCents)}</td><td class="num">${money(r.newCents)}</td><td class="num">${money(r.deltaCents, { sign: true })}</td>${d.retroactive ? html`<td class="num">${money(r.restatedBalanceDeltaCents, { sign: true })}</td>` : ''}</tr>`)}</tbody></table>
      ${d.retroactive ? html`<p class="err"><b>This restates history.</b> Balances change as shown. Type RESTATE to confirm.</p><input .value=${this.confirmText} @input=${(e: any) => (this.confirmText = e.target.value)} />` : ''}
      <div class="row" style="margin-top:12px"><button @click=${() => (this.diff = null)}>Cancel</button><button class="primary" ?disabled=${d.retroactive && this.confirmText !== 'RESTATE'} @click=${() => this.go()}>Confirm</button></div></dialog>`;
  }
}
