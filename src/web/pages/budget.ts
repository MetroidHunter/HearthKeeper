import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { pace } from '../shared.js';
import { draw } from '../charts.js';

@customElement('hk-budget')
export class Budget extends Page {
  @state() data: any = null; @state() view: 'table' | 'pie' = 'table'; @state() pieMode: 'allocated' | 'spent' = 'allocated'; @state() pie: any = null; @state() drill: string | null = null; @state() editing: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.data = await api.get('/api/budget'); this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }); }
  updated() { if (this.view === 'pie' && this.pie) this.drawPie(); }
  drawPie() {
    const el = this.querySelector('.chart') as HTMLElement; if (!el) return;
    const g = this.drill ? this.pie.groups.find((x: any) => x.name === this.drill) : null;
    const data = g ? g.categories.map((c: any) => ({ name: c.name, value: c.cents })) : this.pie.groups.map((x: any) => ({ name: x.name, value: x.cents }));
    void draw(el, { tooltip: { formatter: (p: any) => `${p.name}: ${money(p.value)} (${p.percent}%)` }, series: [{ type: 'pie', radius: ['35%', '70%'], data, label: { formatter: '{b}\n{d}%' } }] },
      (p: any) => { if (!this.drill) this.drill = p.name; });
  }
  async saveBudget(r: any, v: string, month: string) { await this.run(() => api.post(`/api/categories/${r.id}/budget`, { monthlyCents: parseMoney(v), effectiveMonth: month })); this.editing = null; this.load(); }
  render() {
    const d = this.data; if (!d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const h = d.header; const groups = new Map<string, any[]>();
    for (const r of d.rows) (groups.get(r.group ?? 'Other') ?? groups.set(r.group ?? 'Other', []).get(r.group ?? 'Other')!).push(r);
    return html`<h1>Budget</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card row"><div class="grow"><div class="muted">Live plan</div><b>${h.livePlan ?? 'none'}</b></div>
        <div><div class="muted">Income</div><b>${money(h.incomeCents)}</b></div><div><div class="muted">Allocated</div><b>${money(h.allocatedCents)}</b></div>
        <div><div class="muted">Unallocated</div><b class=${h.unallocatedCents < 0 ? 'neg' : ''}>${money(h.unallocatedCents)}</b></div></div>
      <div class="tabs"><button class=${this.view === 'table' ? 'primary' : ''} @click=${() => (this.view = 'table')}>Table</button><button class=${this.view === 'pie' ? 'primary' : ''} @click=${() => { this.view = 'pie'; this.drill = null; }}>Pie</button>
        ${this.view === 'pie' ? html`<button @click=${async () => { this.pieMode = this.pieMode === 'allocated' ? 'spent' : 'allocated'; this.drill = null; this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }}>Share of ${this.pieMode} ↔</button>${this.drill ? html`<button @click=${() => (this.drill = null)}>← all groups</button>` : ''}` : ''}</div>
      ${this.view === 'pie' ? html`<div class="card"><div class="chart"></div><div class="muted">${this.drill ? this.drill : 'Click a group to drill into its categories.'}</div></div>` : html`<div class="card" style="overflow-x:auto"><table>
        <thead><tr><th>Category</th><th class="num">Target</th><th class="num">Current</th><th class="num">Spent (this)</th><th class="num hide-sm">Spent (last)</th><th class="hide-sm">Pace</th></tr></thead>
        ${[...groups].map(([g, rows]) => html`<tbody><tr><th colspan="6">${g}</th></tr>${rows.map((r) => html`<tr>
          <td><a href="#/categories/${r.id}">${r.name}</a></td>
          <td class="num"><a href="#" @click=${(e: Event) => { e.preventDefault(); this.editing = r; }}>${money(r.targetCents)}</a></td>
          <td class="num ${r.currentCents < 0 ? 'neg' : ''}">${money(r.currentCents)}</td>
          <td class="num">${money(r.kind === 'expense' ? r.spent[0] : r.gained[0])}</td><td class="num hide-sm">${money(r.kind === 'expense' ? r.spent[1] : r.gained[1])}</td>
          <td class="hide-sm" style="width:120px"><div class="bar ${r.spent[0] > r.targetCents ? 'over' : ''}"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div></td></tr>`)}</tbody>`)}</table></div>`}
      ${this.editing ? this.editDialog() : ''}`;
  }
  editDialog() {
    const r = this.editing; let v = (r.targetCents / 100).toFixed(2), m = new Date().toISOString().slice(0, 7);
    return html`<dialog open><h2 style="margin-top:0">${r.name}: monthly amount</h2>
      <p class="muted">The old value is kept in this category's history timeline. Default is this month; pick an earlier month to restate history.</p>
      <div class="row"><input .value=${v} @input=${(e: any) => (v = e.target.value)} inputmode="decimal" /><input type="month" .value=${m} @input=${(e: any) => (m = e.target.value)} /></div>
      <div class="row" style="margin-top:12px"><button @click=${() => (this.editing = null)}>Cancel</button><button class="primary" @click=${() => this.saveBudget(r, v, m)}>Save</button></div></dialog>`;
  }
}
