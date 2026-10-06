import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { draw, theme } from '../charts.js';
import { pageHead } from '../ui.js';

const k = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;

/** The state of the household at a glance: callouts you can act on, then four diagrams. */
@customElement('hk-dashboard')
export class Dashboard extends Page {
  @state() d: any = null; @state() b: any = null; @state() inbox: any = null; @state() iv: any[] = []; @state() pie: any = null; @state() bva: any[] = [];
  connectedCallback() {
    super.connectedCallback();
    this.run(async () => { [this.d, this.b, this.inbox, this.iv, this.pie, this.bva] = await Promise.all([api.get('/api/dashboard'), api.get('/api/budget'), api.get('/api/inbox'), api.get('/api/analytics/income-vs-spend'), api.get('/api/budget/pie?mode=spent'), api.get(`/api/analytics/budget-vs-actual`)]); });
  }
  updated() { if (this.d) void this.paint(); }
  private async paint() {
    const t = theme(); const el = (n: string) => this.querySelector(`.chart[data-c="${n}"]`) as HTMLElement | null;
    const axis = { axisLabel: { color: t.muted }, axisLine: { lineStyle: { color: t.line } }, splitLine: { lineStyle: { color: t.line } } };
    const a = el('income'); if (a && !a.dataset.drawn) await draw(a, { tooltip: { trigger: 'axis', valueFormatter: (v: number) => money(v) }, legend: { top: 0, textStyle: { color: t.ink } }, grid: { left: 56, right: 10, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: this.iv.map((p) => p.month), ...axis }, yAxis: { type: 'value', ...axis, axisLabel: { color: t.muted, formatter: k } },
      series: [{ name: 'Income', type: 'bar', data: this.iv.map((p) => p.income) }, { name: 'Spent', type: 'bar', data: this.iv.map((p) => p.spent) }, { name: 'Planned', type: 'line', data: this.iv.map((p) => Math.round(p.allocated)), lineStyle: { type: 'dashed' } }] });
    const g = el('groups'); if (g && !g.dataset.drawn && this.pie?.groups.length) await draw(g, { tooltip: { formatter: (p: any) => `${p.name}: ${money(p.value)} (${p.percent}%)` }, legend: { type: 'scroll', bottom: 0, textStyle: { color: t.ink } },
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['50%', '45%'], data: this.pie.groups.map((x: any) => ({ name: x.name, value: x.cents })), label: { show: false } }] }, (p: any) => { location.hash = '#/budget'; void p; });
    const top = [...this.bva].filter((r) => r.budget > 0).map((r) => ({ ...r, used: r.spent / r.budget })).sort((x, y) => y.used - x.used).slice(0, 10).reverse();
    const c = el('pace'); if (c && !c.dataset.drawn && top.length) await draw(c, { tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: any) => { const r = top[ps[0].dataIndex]; return `${r.name}<br>${money(r.spent)} of ${money(r.budget)} (${Math.round(r.used * 100)}%)`; } }, grid: { left: 130, right: 24, top: 8, bottom: 22 },
      xAxis: { type: 'value', max: (v: any) => Math.max(120, Math.ceil(v.max * 100)) / 100, ...axis, axisLabel: { color: t.muted, formatter: (v: number) => `${Math.round(v * 100)}%` } }, yAxis: { type: 'category', data: top.map((r) => r.name), axisLabel: { color: t.ink } },
      series: [{ type: 'bar', data: top.map((r) => ({ value: +r.used.toFixed(3), itemStyle: { color: r.used > 1 ? t.bad : t.brand } })), markLine: { silent: true, symbol: 'none', lineStyle: { color: t.muted, type: 'dashed' }, data: [{ xAxis: 1 }], label: { show: false } } }] });
  }
  render() {
    if (!this.d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const rows: any[] = this.b?.rows ?? []; const h = this.b?.header; const unc = this.b?.uncategorized;
    const exp = rows.filter((r) => r.kind === 'expense');
    const over = exp.filter((r) => r.currentCents < 0);
    const overSum = over.reduce((a, r) => a + r.currentCents, 0);
    const spent = exp.reduce((a, r) => a + r.spent[0], 0), target = exp.reduce((a, r) => a + r.targetCents, 0);
    const counts = this.inbox?.counts;
    return html`${pageHead('Dashboard', 'The state of the household at a glance. The tiles are the things worth acting on and each one opens the place to act; the diagrams below show how the year is going.', 'Charts use your last 12 months and this month. For slicing by anything else, use Analytics or Explore under Discover.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="grid3">
        <a class="stat" href="#/backlog"><span class="label">Needs a decision</span><span class="value">${counts?.total ?? 0}</span><span class="sub">${counts?.needsCategory ?? 0} need a category, ${counts?.flagged ?? 0} flagged</span></a>
        <a class="stat" href="#/backlog"><span class="label">Needs category</span><span class="value ${unc && unc.netCents < 0 ? 'neg' : ''}">${money(unc?.netCents ?? 0)}</span><span class="sub">${unc?.count ?? 0} uncategorized transactions</span></a>
        <a class="stat" href="#/budget"><span class="label">Overspent envelopes</span><span class="value ${over.length ? 'neg' : ''}">${over.length}</span><span class="sub">${over.length ? `${money(overSum)} below zero in total` : 'every envelope is at or above zero'}</span></a>
        <a class="stat" href="#/budget"><span class="label">Spent this month</span><span class="value">${money(spent)}</span><span class="sub">of ${money(target)} planned (${target ? Math.round((spent / target) * 100) : 0}%)</span></a>
        <a class="stat" href="#/plans"><span class="label">Unallocated income</span><span class="value ${h?.unallocatedCents < 0 ? 'neg' : ''}">${money(h?.unallocatedCents)}</span><span class="sub">${money(h?.incomeCents)} income, ${money(h?.allocatedCents)} allocated</span></a>
        <a class="stat" href="#/months"><span class="label">Months to tidy</span><span class="value ${this.d.monthsNeedingWork ? 'neg' : ''}">${this.d.monthsNeedingWork}</span><span class="sub">${this.d.monthsNeedingWork ? `${this.d.monthsOpenItems} open item${this.d.monthsOpenItems === 1 ? '' : 's'} across ${this.d.monthsNeedingWork} of ${this.d.months} months` : `all ${this.d.months} months are done`}</span></a></div>

      <h2>Diagrams</h2>
      <div class="grid2"><div class="card"><h3>Income, spending and plan by month</h3><div class="chart sm" data-c="income"></div></div>
        <div class="card"><h3>Where this month's money went</h3><div class="chart sm" data-c="groups"></div>${this.pie?.groups.length ? nothing : html`<p class="muted">No spending yet this month.</p>`}</div></div>
      <div class="card"><h3>Envelopes closest to (or past) their monthly target</h3><div class="chart sm" data-c="pace"></div><p class="muted small" style="margin-bottom:0">Red bars passed 100% of the month's amount; the dashed line is 100%.</p></div>

      <h2>Health</h2>
      <div class="card flush"><div class="list">${this.d.coverage.map((c: any) => html`<div class="list-row"><span class="grow">${c.institution}</span><span class="muted">last transaction ${c.last_txn ?? 'never'}</span>${c.stale ? html`<span class="badge bad">stale</span>` : html`<span class="badge good">ok</span>`}</div>`)}</div></div>
      ${this.d.silentSources.length ? html`<div class="card"><b class="err">Silent sources</b><div class="list">${this.d.silentSources.map((s: any) => html`<div>${s.label}: quiet ${Number.isFinite(s.hoursSilent) ? `${Math.round(s.hoursSilent)}h` : 'since setup'}</div>`)}</div></div>` : nothing}
      ${this.d.invariants.length ? html`<div class="card"><b class="err">Data invariants violated</b>${this.d.invariants.map((i: string) => html`<div>${i}</div>`)}</div>` : nothing}`;
  }
}
