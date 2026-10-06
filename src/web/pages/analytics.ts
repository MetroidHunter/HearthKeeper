import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { draw, theme, PALETTE } from '../charts.js';
import { thisMonth, type Cat } from '../shared.js';
import { pageHead, th } from '../ui.js';

type Tab = 'bva' | 'time' | 'tree' | 'trend' | 'income' | 'merchants' | 'years';
const TABS: [Tab, string][] = [['bva', 'Budget vs actual'], ['time', 'Spend over time'], ['tree', 'Treemap'], ['trend', 'Category trend'], ['income', 'Income vs spend'], ['merchants', 'Merchants'], ['years', 'Year pivot']];
const $ = (n: number) => `$${Math.round(n / 100).toLocaleString('en-US')}`;
const drillTo = (q: string) => { location.hash = `#/transactions?${q}`; }; // every chart drills down to the underlying transactions (design §14.2)

/** The chart catalog of design §14.2. Aggregates are plain SQL on the server; ECharts loads on first use. */
@customElement('hk-analytics')
export class Analytics extends Page {
  @state() tab: Tab = 'bva'; @state() months = 12; @state() month = thisMonth(); @state() cats: Cat[] = []; @state() trendCat = 0; @state() mdim = 'merchant'; @state() years: any = null; @state() loaded = false;
  connectedCallback() { super.connectedCallback(); this.run(async () => { this.cats = await api.get('/api/categories'); this.trendCat = this.cats.find((c) => c.name === 'Groceries')?.id ?? this.cats[0]?.id ?? 0; this.loaded = true; }); }
  updated() { if (this.loaded) void this.paint(); }
  private from() { const [y, m] = thisMonth().split('-').map(Number); const i = y * 12 + m - 1 - (this.months - 1); return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; }
  private el() { return this.querySelector('.chart') as HTMLElement | null; }
  private async paint() {
    const el = this.el(); const t = theme(); const key = `${this.tab}|${this.months}|${this.month}|${this.trendCat}|${this.mdim}`;
    if (this.tab === 'years') { if (!this.years) this.years = await api.get('/api/analytics/year-pivot'); return; }
    if (!el || el.dataset.key === key) return; el.dataset.key = key;
    const axis = { axisLabel: { color: t.muted }, axisLine: { lineStyle: { color: t.line } }, splitLine: { lineStyle: { color: t.line } } };
    await this.run(async () => {
      if (this.tab === 'bva') {
        const rows = (await api.get(`/api/analytics/budget-vs-actual?month=${this.month}`)).reverse(); // every category, each with room: ~40px a row
        el.style.height = `${Math.max(360, rows.length * 40 + 90)}px`;
        await draw(el, { tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => money(v) }, grid: { left: 170, right: 24, top: 36, bottom: 24 }, legend: { top: 0, textStyle: { color: t.ink } },
          xAxis: { type: 'value', ...axis, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } }, yAxis: { type: 'category', data: rows.map((r: any) => r.name), axisLabel: { color: t.ink } },
          series: [{ name: 'Budget', type: 'bar', barWidth: 24, data: rows.map((r: any) => r.budget), itemStyle: { color: t.line }, z: 1 },
            { name: 'Spent', type: 'bar', barGap: '-100%', barWidth: 12, z: 3, data: rows.map((r: any) => ({ value: r.spent, itemStyle: { color: r.spent > r.budget ? t.bad : t.brand } })) }] }, (p: any) => { const r = rows[p.dataIndex]; if (r) drillTo(`category=${r.id}&from=${this.month}-01&to=${this.month}-31`); });
      } else if (this.tab === 'time') {
        const m = await api.get(`/api/analytics/monthly?by=group&from=${this.from()}`);
        await draw(el, { tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, legend: { type: 'scroll', top: 0, textStyle: { color: t.ink } }, grid: { left: 60, right: 10, top: 40, bottom: 30 },
          xAxis: { type: 'category', data: m.months, ...axis }, yAxis: { type: 'value', ...axis, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } },
          series: m.rows.map((r: any) => ({ name: r.key, type: 'bar', stack: 'spend', data: r.values })) });
      } else if (this.tab === 'tree') {
        const tm = await api.get(`/api/analytics/treemap?from=${this.from()}`);
        el.style.height = '420px';
        await draw(el, { tooltip: { formatter: (p: any) => `${p.name}: ${money(p.value)}` }, series: [{ type: 'treemap', roam: false, nodeClick: 'zoomToNode', breadcrumb: { show: true }, label: { formatter: (p: any) => `${p.name}\n${$(p.value)}` }, data: tm }] });
      } else if (this.tab === 'trend') {
        const tr = await api.get(`/api/analytics/trend/${this.trendCat}?from=${this.from()}`);
        await draw(el, { tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, legend: { top: 0, textStyle: { color: t.ink } }, grid: { left: 60, right: 60, top: 40, bottom: 30 },
          xAxis: { type: 'category', data: tr.map((p: any) => p.month), ...axis }, yAxis: [{ type: 'value', ...axis, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } }, { type: 'value', splitLine: { show: false }, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } }],
          series: [{ name: 'Spent', type: 'bar', data: tr.map((p: any) => p.spent) }, { name: 'Trailing 3-mo avg', type: 'line', smooth: true, data: tr.map((p: any) => Math.round(p.trailingAvg)) },
            { name: 'Budget', type: 'line', step: 'end', data: tr.map((p: any) => p.budget), lineStyle: { type: 'dashed' } }, { name: 'Envelope balance', type: 'line', yAxisIndex: 1, data: tr.map((p: any) => p.balance) }] },
          (p: any) => { const pt = tr[p.dataIndex]; if (pt) drillTo(`category=${this.trendCat}&from=${pt.month}-01&to=${pt.month}-31`); });
      } else if (this.tab === 'income') {
        const iv = await api.get(`/api/analytics/income-vs-spend?from=${this.from()}`);
        await draw(el, { tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, legend: { top: 0, textStyle: { color: t.ink } }, grid: { left: 60, right: 10, top: 40, bottom: 30 },
          xAxis: { type: 'category', data: iv.map((p: any) => p.month), ...axis }, yAxis: { type: 'value', ...axis, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } },
          series: [{ name: 'Income', type: 'bar', data: iv.map((p: any) => p.income) }, { name: 'Spent', type: 'bar', data: iv.map((p: any) => p.spent) }, { name: 'Allocated', type: 'line', data: iv.map((p: any) => Math.round(p.allocated)), lineStyle: { type: 'dashed' } }] });
      } else if (this.tab === 'merchants') {
        const [y, mo] = thisMonth().split('-'); void y; void mo;
        const rows = (await api.get(`/api/reports/spend-by?dim=${this.mdim}&from=${this.from()}-01&to=${thisMonth()}-31`)).filter((r: any) => r.key !== '(none)').slice(0, 25).reverse();
        el.style.height = `${Math.max(300, rows.length * 24 + 60)}px`;
        await draw(el, { tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, grid: { left: 190, right: 20, top: 10, bottom: 20 }, xAxis: { type: 'value', ...axis, axisLabel: { color: t.muted, formatter: (v: number) => $(v) } },
          yAxis: { type: 'category', data: rows.map((r: any) => r.key), axisLabel: { color: t.ink } }, series: [{ type: 'bar', data: rows.map((r: any) => r.spent), itemStyle: { color: PALETTE[0] } }] }, (p: any) => { const r = rows[p.dataIndex]; if (r) drillTo(`q=${encodeURIComponent(r.key)}`); });
      }
    });
  }
  render() {
    return html`${pageHead('Analytics', 'Charts for how spending, income and budgets move over time.', 'Pick a chart from the tabs. Most charts let you click through to the transactions behind a bar or block.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="tabs">${TABS.map(([k, label]) => html`<button class=${this.tab === k ? 'primary' : ''} data-tab=${k} @click=${() => { this.tab = k; const el = this.el(); if (el) delete el.dataset.key; }}>${label}</button>`)}</div>
      <div class="row" style="margin-bottom:8px">
        ${['bva'].includes(this.tab) ? html`<input type="month" .value=${this.month} @change=${(e: any) => (this.month = e.target.value)} />` : this.tab !== 'years' ? html`<label class="muted">Range <select @change=${(e: any) => (this.months = Number(e.target.value))}>${[6, 12, 24, 36, 60].map((n) => html`<option value=${n} ?selected=${n === this.months}>${n} months</option>`)}</select></label>` : ''}
        ${this.tab === 'trend' ? html`<select id="trend-cat" @change=${(e: any) => (this.trendCat = Number(e.target.value))}>${this.cats.filter((c) => c.kind === 'expense').map((c) => html`<option value=${c.id} ?selected=${c.id === this.trendCat}>${c.name}</option>`)}</select>` : ''}
        ${this.tab === 'merchants' ? html`<select @change=${(e: any) => (this.mdim = e.target.value)}><option value="merchant">By merchant</option><option value="merchant_group">By merchant group</option></select>` : ''}
        <span class="muted">Click a bar or cell to see the transactions behind it.</span></div>
      ${this.tab === 'years' ? this.yearTable() : html`<div class="card"><div class="chart" style="height:380px"></div></div>`}`;
  }
  yearTable() {
    const y = this.years; if (!y) return html`<p class="muted">Loading…</p>`;
    return html`<div class="card" style="overflow-x:auto"><table><thead><tr>${th('Category', 'Spending category.')}${y.years.map((yr: number) => th(String(yr), `Net spending in ${yr}.`, 'num'))}${th('Total', 'All years shown.', 'num')}</tr></thead><tbody>
      ${y.rows.map((r: any) => html`<tr><td>${r.key}</td>${r.values.map((v: number) => html`<td class="num">${v ? money(v) : ''}</td>`)}<td class="num"><b>${money(r.total)}</b></td></tr>`)}</tbody></table></div>`;
  }
}
