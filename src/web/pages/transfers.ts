import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { today, type Cat } from '../shared.js';
import { catSelect } from '../ui.js';
import { pageHead, th } from '../ui.js';

@customElement('hk-transfers')
export class Transfers extends Page {
  @state() cats: Cat[] = []; @state() prop: any = null; @state() history: any[] = []; @state() manual = { from: 0, to: 0, amount: '', memo: '' }; @state() place: { pool: number; rows: { categoryId: number; cents: number }[] } = { pool: 0, rows: [] }; @state() poolBal: Record<number, number> = {};
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.cats, this.history] = await Promise.all([api.get('/api/categories'), api.get('/api/transfers')]); const b = await api.get('/api/budget'); this.poolBal = Object.fromEntries(b.rows.filter((r: any) => r.kind === 'income_pool').map((r: any) => [r.id, r.currentCents])); }); }
  name(id: number) { return this.cats.find((c) => c.id === id)?.name ?? `#${id}`; }
  async propose() { await this.run(async () => { this.prop = await api.get(`/api/transfers/rebalance?asOf=${today()}`); }); }
  edit(list: 'poolPayments' | 'donorMoves', i: number, v: string) { this.prop[list][i].cents = parseMoney(v || '0'); this.requestUpdate(); }
  async commit() { await this.run(async () => { await api.post('/api/transfers/rebalance', { asOf: today(), poolPayments: this.prop.poolPayments.filter((x: any) => x.cents > 0), donorMoves: this.prop.donorMoves.filter((x: any) => x.cents > 0) }); this.prop = null; await this.load(); }); }
  render() {
    const pools = this.cats.filter((c) => c.kind === 'income_pool');
    return html`${pageHead('Transfers', 'Move money between envelopes: cover overspending, place income, or make a one-off move.', 'Rebalance proposes covering overspent categories from the income pool and then from discretionary envelopes with room to spare. You review the proposal before anything moves.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <h2>Rebalance overages</h2>
      <div class="card"><p class="muted">Gig Income pays overages first (in priority order), then discretionary donors, then non-discretionary donors, taking only what is above their monthly budget plus cushion (an empty cushion counts as 0) (a $150 budget with a $50 cushion is touched only when it holds more than $200). Edit any amount before committing.</p>
        <button class="primary" @click=${() => this.propose()}>Propose</button>
        ${this.prop ? html`${this.prop.poolPayments.length + this.prop.donorMoves.length === 0 ? html`<p>Nothing to rebalance.</p>` : ''}
          <table><tbody>${this.prop.poolPayments.map((m: any, i: number) => html`<tr><td>Pool ${this.name(m.poolCategoryId)} → <b>${this.name(m.toCategoryId)}</b></td><td class="num"><input style="width:7rem;text-align:right" .value=${(m.cents / 100).toFixed(2)} @change=${(e: any) => this.edit('poolPayments', i, e.target.value)} /></td></tr>`)}
          ${this.prop.donorMoves.map((m: any, i: number) => html`<tr><td>${this.name(m.fromCategoryId)} → <b>${this.name(m.toCategoryId)}</b></td><td class="num"><input style="width:7rem;text-align:right" .value=${(m.cents / 100).toFixed(2)} @change=${(e: any) => this.edit('donorMoves', i, e.target.value)} /></td></tr>`)}</tbody></table>
          ${this.prop.remainingShortfall.length ? html`<p class="err">Unfunded: ${this.prop.remainingShortfall.map((s: any) => `${this.name(s.categoryId)} ${money(s.cents)}`).join(', ')}</p>` : ''}
          <h2>Resulting balances</h2><div class="muted">${Object.entries(this.prop.resulting).map(([k, v]) => html`<div>${this.name(Number(k))}: ${money(v as number)}</div>`)}</div>
          <div class="row" style="margin-top:8px"><button @click=${() => (this.prop = null)}>Discard</button><button class="primary" ?disabled=${this.prop.poolPayments.length + this.prop.donorMoves.length === 0} @click=${() => this.commit()}>Commit</button></div>` : ''}</div>
      <h2>Place the pool by hand</h2>
      <div class="card">${pools.map((p) => html`<div>${p.name}: <b>${money(this.poolBal[p.id] ?? 0)}</b> <button @click=${() => (this.place = { pool: p.id, rows: [{ categoryId: 0, cents: 0 }] })}>Place…</button></div>`)}
        ${this.place.pool ? html`${this.place.rows.map((r, i) => html`<div class="row" style="margin-top:6px"><span class="grow">${catSelect(this.cats, r.categoryId, (id) => (r.categoryId = id ?? 0))}</span><input style="width:7rem" placeholder="0.00" @input=${(e: any) => { r.cents = parseMoney(e.target.value || '0'); this.requestUpdate(); }} /></div>`)}
          <div class="row" style="margin-top:6px"><button @click=${() => { this.place.rows.push({ categoryId: 0, cents: 0 }); this.requestUpdate(); }}>＋ row</button>
            <span class="muted">remaining ${money((this.poolBal[this.place.pool] ?? 0) - this.place.rows.reduce((a, r) => a + r.cents, 0))}</span>
            <button class="primary" @click=${async () => { await this.run(() => api.post('/api/transfers/place-pool', { asOf: today(), poolCategoryId: this.place.pool, allocations: this.place.rows.filter((r) => r.categoryId && r.cents).map((r) => ({ categoryId: r.categoryId, cents: r.cents })) })); this.place = { pool: 0, rows: [] }; this.load(); }}>Commit</button></div>` : ''}</div>
      <h2>Manual transfer / zero-out</h2>
      <div class="card"><div class="row">${catSelect(this.cats, null, (id) => (this.manual.from = id ?? 0), { placeholder: 'From category' })}<span>→</span>${catSelect(this.cats, null, (id) => (this.manual.to = id ?? 0), { placeholder: 'To category' })}
        <input style="width:7rem" placeholder="0.00" @input=${(e: any) => (this.manual.amount = e.target.value)} /><input class="grow" placeholder="Memo" @input=${(e: any) => (this.manual.memo = e.target.value)} />
        <button class="primary" @click=${async () => { await this.run(() => api.post('/api/transfers/manual', { from: this.manual.from, to: this.manual.to, cents: parseMoney(this.manual.amount), memo: this.manual.memo })); this.load(); }}>Move</button>
        <button class="danger" title="Single-leg write-off of the source envelope's amount" @click=${async () => { if (!confirm('Write off this amount from the source envelope (no matching credit)?')) return; await this.run(() => api.post('/api/transfers/adjustment', { categoryId: this.manual.from, cents: -parseMoney(this.manual.amount), reason: this.manual.memo || 'zero out' })); this.load(); }}>Zero out</button></div></div>
      <h2>History</h2><div class="card" style="overflow-x:auto"><table><tbody>${this.history.map((h) => html`<tr><td>${h.occurred_on}</td><td><span class="badge">${h.kind}</span></td><td>${JSON.parse(h.legs).map((l: any) => `${this.name(l.categoryId)} ${money(l.cents, { sign: true })}`).join(' · ')}</td><td class="muted hide-sm">${h.memo ?? ''}</td></tr>`)}</tbody></table></div>`;
  }
}
