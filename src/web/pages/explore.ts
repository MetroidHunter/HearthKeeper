import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { today } from '../shared.js';
import { draw } from '../charts.js';

@customElement('hk-explore')
export class Explore extends Page {
  @state() q = decodeURIComponent((location.hash.split('?q=')[1] ?? '')); @state() from = `${Number(today().slice(0, 4)) - 1}-01-01`; @state() to = today(); @state() res: any = null; @state() dim = 'category'; @state() rows: any[] = [];
  connectedCallback() { super.connectedCallback(); if (this.q) this.search(); this.top(); }
  async search() { await this.run(async () => { this.res = await api.get(`/api/explore?q=${encodeURIComponent(this.q)}&from=${this.from}&to=${this.to}`); }); }
  async top() { await this.run(async () => { this.rows = await api.get(`/api/reports/spend-by?dim=${this.dim}&from=${this.from}&to=${this.to}`); }); }
  updated() {
    const el = this.querySelector('.chart') as HTMLElement | null; if (!el || !this.res) return;
    void draw(el, { tooltip: {}, grid: { left: 50, right: 10, top: 10, bottom: 30 }, xAxis: { type: 'category', data: this.res.sparkline.map((s: any) => s.month) }, yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `$${v / 100}` } }, series: [{ type: 'bar', data: this.res.sparkline.map((s: any) => s.cents) }] });
  }
  render() {
    return html`<h1>Explore</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row"><input class="grow" type="search" placeholder='Merchant, note or item, e.g. "Sephora"' .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.search()} /><input type="date" .value=${this.from} @change=${(e: any) => { this.from = e.target.value; this.top(); }} /><input type="date" .value=${this.to} @change=${(e: any) => { this.to = e.target.value; this.top(); }} /><button class="primary" @click=${() => this.search()}>Search</button></div>
      ${this.res ? html`<div class="card" style="margin-top:10px"><div class="row"><span>Total <b>${money(this.res.totalCents)}</b></span><span>Monthly avg <b>${money(this.res.monthlyAverageCents)}</b></span><span>Count <b>${this.res.count}</b></span></div><div class="chart" style="height:220px"></div></div>` : ''}
      <h2>Spend by</h2><div class="tabs">${['category', 'merchant', 'merchant_group', 'month', 'account'].map((d) => html`<button class=${this.dim === d ? 'primary' : ''} @click=${() => { this.dim = d; this.top(); }}>${d.replace('_', ' ')}</button>`)}</div>
      <div class="card"><table><tbody>${this.rows.map((r) => html`<tr><td>${r.key}</td><td class="num">${r.count}</td><td class="num">${money(r.spent)}</td></tr>`)}</tbody></table></div>`;
  }
}
