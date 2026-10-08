import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { today } from '../shared.js';
import { draw } from '../charts.js';
import { pageHead, pagerBar } from '../ui.js';

@customElement('hk-explore')
export class Explore extends Page {
  @state() q = decodeURIComponent((location.hash.split('?q=')[1] ?? '')); @state() from = `${Number(today().slice(0, 4)) - 1}-01-01`; @state() to = today(); @state() res: any = null; @state() dim = 'category'; @state() rows: any[] = [];
  /** Table controls for "Spend by": search, sortable columns, paging. All client-side: the whole list is already here. */
  @state() sq = ''; @state() sortCol: 'key' | 'count' | 'spent' = 'spent'; @state() sortDir: 1 | -1 = -1; @state() page = 0; @state() size = 25;
  connectedCallback() { super.connectedCallback(); if (this.q) this.search(); this.top(); }
  async search() { await this.run(async () => { this.res = await api.get(`/api/explore?q=${encodeURIComponent(this.q)}&from=${this.from}&to=${this.to}`); }); }
  async top() { await this.run(async () => { this.rows = await api.get(`/api/reports/spend-by?dim=${this.dim}&from=${this.from}&to=${this.to}`); }); }
  private setDim(d: string) { this.dim = d; this.sq = ''; this.page = 0; this.sortCol = d === 'month' ? 'key' : 'spent'; this.sortDir = -1; void this.top(); } // months read newest first; everything else biggest first
  private sortBy(c: 'key' | 'count' | 'spent') { if (this.sortCol === c) this.sortDir = (this.sortDir * -1) as 1 | -1; else { this.sortCol = c; this.sortDir = c === 'key' ? 1 : -1; } this.page = 0; }
  private shown() {
    const q = this.sq.trim().toLowerCase(); const list = q ? this.rows.filter((r) => String(r.key).toLowerCase().includes(q)) : [...this.rows];
    const c = this.sortCol, d = this.sortDir;
    return list.sort((a, b) => (c === 'key' ? String(a.key).localeCompare(String(b.key), undefined, { numeric: true }) : a[c] - b[c]) * d || String(a.key).localeCompare(String(b.key)));
  }
  private sortHead(c: 'key' | 'count' | 'spent', label: string, tip: string, cls = '') {
    const on = this.sortCol === c;
    return html`<th class=${cls} data-tip=${tip} aria-sort=${on ? (this.sortDir === 1 ? 'ascending' : 'descending') : 'none'}><button class="link sorter" data-col=${c} @click=${() => this.sortBy(c)}>${label}${on ? (this.sortDir === 1 ? ' ▲' : ' ▼') : ''}</button></th>`;
  }
  private spendBy() {
    const all = this.shown(); const last = Math.max(0, Math.ceil(all.length / this.size) - 1); if (this.page > last) this.page = last;
    const rows = all.slice(this.page * this.size, (this.page + 1) * this.size);
    const total = all.reduce((a, r) => a + r.spent, 0), n = all.reduce((a, r) => a + r.count, 0);
    return html`<div class="row"><input class="grow spend-search" type="search" placeholder=${`Search ${this.dim.replace('_', ' ')}`} aria-label="Search the table" .value=${this.sq} @input=${(e: any) => { this.sq = e.target.value; this.page = 0; }} />
        <span class="muted small" aria-live="polite">${all.length === this.rows.length ? `${all.length.toLocaleString()} rows` : `${all.length.toLocaleString()} of ${this.rows.length.toLocaleString()} rows`}</span></div>
      ${all.length > this.size ? pagerBar({ page: this.page, total: all.length, size: this.size, sizes: [25, 50, 100, 200], onPage: (p) => (this.page = p), onSize: (s) => { this.size = s; this.page = 0; } }) : nothing}
      <div class="card flush" style="overflow-x:auto"><table class="spendby"><thead><tr>${this.sortHead('key', this.dim.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()), 'Click to sort by name.')}${this.sortHead('count', 'Transactions', 'How many transactions. Click to sort.', 'num')}${this.sortHead('spent', 'Spent', 'Net spending (refunds reduce it). Click to sort.', 'num')}</tr></thead>
        <tbody>${rows.map((r) => html`<tr><td>${r.key}</td><td class="num">${r.count}</td><td class="num">${money(r.spent)}</td></tr>`)}${rows.length === 0 ? html`<tr><td colspan="3" class="muted">${this.sq ? 'Nothing matches.' : 'No spending in this period.'}</td></tr>` : nothing}</tbody>
        <tfoot><tr><td><b>${this.sq ? 'Matching rows' : 'All rows'}</b></td><td class="num"><b>${n.toLocaleString()}</b></td><td class="num"><b>${money(total)}</b></td></tr></tfoot></table></div>`;
  }
  updated() {
    const el = this.querySelector('.chart') as HTMLElement | null; if (!el || !this.res) return;
    void draw(el, { tooltip: {}, grid: { left: 50, right: 10, top: 10, bottom: 30 }, xAxis: { type: 'category', data: this.res.sparkline.map((s: any) => s.month) }, yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `$${v / 100}` } }, series: [{ type: 'bar', data: this.res.sparkline.map((s: any) => s.cents) }] });
  }
  render() {
    return html`${pageHead('Explore', 'Search and slice your spending any way you like: by category, merchant, month or account.', 'Click any number to see the transactions behind it.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row"><input class="grow" type="search" placeholder='Merchant, note or item, e.g. "Sephora"' .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.search()} /><input type="date" .value=${this.from} @change=${(e: any) => { this.from = e.target.value; this.top(); }} /><input type="date" .value=${this.to} @change=${(e: any) => { this.to = e.target.value; this.top(); }} /><button class="primary" @click=${() => this.search()}>Search</button></div>
      ${this.res ? html`<div class="card" style="margin-top:10px"><div class="row"><span>Total <b>${money(this.res.totalCents)}</b></span><span>Monthly avg <b>${money(this.res.monthlyAverageCents)}</b></span><span>Count <b>${this.res.count}</b></span></div><div class="chart" style="height:220px"></div></div>` : ''}
      <h2>Spend by</h2><div class="tabs">${['category', 'merchant', 'merchant_group', 'month', 'account'].map((d) => html`<button class=${this.dim === d ? 'primary' : ''} @click=${() => this.setDim(d)}>${d.replace('_', ' ')}</button>`)}</div>
      ${this.spendBy()}`;
  }
}
