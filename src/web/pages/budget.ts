import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { pace } from '../shared.js';
import { pageHead, th } from '../ui.js';
import { draw, theme, PALETTE } from '../charts.js';

@customElement('hk-budget')
export class Budget extends Page {
  @state() data: any = null; @state() view: 'table' | 'pie' = 'table'; @state() pieMode: 'allocated' | 'spent' = 'allocated'; @state() pie: any = null; @state() drill: string | null = null; @state() editing: any = null; @state() editV = ''; @state() editM = '';
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.data = await api.get('/api/budget'); this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }); }
  updated() { if (this.view === 'pie' && this.pie) this.drawPie(); }
  drawPie() {
    const el = this.querySelector('.chart') as HTMLElement; if (!el) return;
    const g = this.drill ? this.pie.groups.find((x: any) => x.name === this.drill) : null;
    const narrow = el.clientWidth < 520; // phones: the list under the chart names the slices
    const data = g ? g.categories.map((c: any) => ({ name: c.name, value: c.cents })) : this.pie.groups.map((x: any) => ({ name: x.name, value: x.cents }));
    void draw(el, { tooltip: { formatter: (p: any) => `${p.name}: ${money(p.value)} (${p.percent}%)` }, series: [{ type: 'pie', radius: narrow ? ['38%', '85%'] : ['35%', '70%'], data, label: narrow ? { show: false } : { formatter: '{b}\n{d}%', color: theme().ink }, labelLine: narrow ? { show: false } : { lineStyle: { color: theme().muted } } }] },
      (p: any) => { if (!this.drill) this.drill = p.name; });
  }
  /** The pie's legend: name, amount and share per slice (tap a group to drill in). Always readable, unlike labels around a small chart. */
  pieList() {
    if (!this.pie) return nothing; // still loading
    const g = this.drill ? this.pie.groups.find((x: any) => x.name === this.drill) : null;
    const items: { name: string; cents: number }[] = g ? g.categories : this.pie.groups; const total = items.reduce((t, i) => t + i.cents, 0) || 1;
    return html`<div class="pielist">${items.map((i, n) => html`<button class="pierow" ?disabled=${!!g} @click=${() => { if (!g) this.drill = i.name; }}><i style="background:${PALETTE[n % PALETTE.length]}"></i><span class="pn">${i.name}</span><span class="pa">${money(i.cents)}</span><span class="pp">${Math.round((i.cents / total) * 1000) / 10}%</span></button>`)}</div>`;
  }
  async saveBudget(r: any, v: string, month: string) { await this.run(() => api.post(`/api/categories/${r.id}/budget`, { monthlyCents: parseMoney(v), effectiveMonth: month })); this.editing = null; this.load(); }
  async toggleFavorite(r: any) { await this.run(() => (r.favorite ? api.del(`/api/favorites/${r.id}`) : api.post('/api/favorites', { categoryId: r.id }))); this.load(); }
  render() {
    const d = this.data; if (!d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const h = d.header; const groups = new Map<string, any[]>();
    for (const r of d.rows) (groups.get(r.group ?? 'Other') ?? groups.set(r.group ?? 'Other', []).get(r.group ?? 'Other')!).push(r);
    const unc = d.uncategorized;
    return html`${pageHead('Budget', 'Every envelope, grouped, with what you planned for it each month, what is left in it, and how this month is going. Money you do not spend stays in the envelope and rolls forward.', 'Click a category to see its history and transactions. Use the pencil to change a monthly amount; the old value is kept in its timeline. ☆ pins a category to Home.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="grid3 bstats">
        <div class="stat plan"><span class="label">Live plan</span><span class="value" style="font-size:20px">${h.livePlan ?? 'none'}</span></div>
        <div class="stat combo"><span class="label">Allocated / income (unallocated)</span>
          <span class="value"><span>${money(h.allocatedCents)}</span> <span class="of">/ ${money(h.incomeCents)}</span> <span class="un ${h.unallocatedCents < 0 ? 'neg' : 'pos'}">(${money(h.unallocatedCents)})</span></span>
          <span class="sub">per month; unallocated is income minus allocated</span></div></div>
      ${unc && unc.count ? html`<a class="stat" href="#/backlog"><span class="label">Needs category</span><span class="value ${unc.netCents < 0 ? 'neg' : ''}">${money(unc.netCents)}</span><span class="sub">${unc.count} transactions have no category yet, so they are not in any envelope below. Categorize them in the Backlog and each amount moves into its category.</span></a>` : nothing}
      <div class="tabs"><button aria-pressed=${this.view === 'table'} @click=${() => (this.view = 'table')}>Groups</button><button aria-pressed=${this.view === 'pie'} @click=${() => { this.view = 'pie'; this.drill = null; }}>Pie</button>
        ${this.view === 'pie' ? html`<button @click=${async () => { this.pieMode = this.pieMode === 'allocated' ? 'spent' : 'allocated'; this.drill = null; this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }}>Share of ${this.pieMode} ↔</button>${this.drill ? html`<button @click=${() => (this.drill = null)}>← all groups</button>` : ''}` : ''}</div>
      ${this.view === 'pie' ? html`<div class="card"><div class="chart"></div><div class="muted">${this.drill ? this.drill : 'Click a group to drill into its categories.'}</div>${this.pieList()}</div>` : [...groups].map(([g, rows]) => this.group(g, rows))}
      ${this.editing ? this.editDialog() : ''}`;
  }
  group(name: string, rows: any[]) {
    return html`<section class="card flush group" data-group=${name}><div class="row" style="padding:16px 16px 8px"><h3 class="grow" style="font-size:19px">${name}</h3></div>
      <div class="btable" style="overflow-x:auto"><table style="font-size:16px"><thead><tr>${th('Category', 'The envelope. Click a row for its history and transactions.')}${th('Target', 'Monthly amount planned for this envelope. Use the pencil to change it.', 'num')}${th('Current', 'What is in the envelope now: everything accrued so far, minus spending, plus or minus transfers.', 'num')}${th('Spent (this)', 'Spent this period (net of refunds). For income categories this shows what came in.', 'num')}${th('Spent (last)', 'Same, for the previous period.', 'num hide-sm')}${th('Pace', 'Spent this period against the monthly target. Red means over.', 'hide-sm')}</tr></thead>
        <tbody>${rows.map((r) => html`<tr class="clickable" @click=${() => (location.hash = `#/categories/${r.id}`)}>
          <td style="padding:12px"><span class="row" style="gap:8px"><button class="link icon fav" title=${r.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${(e: Event) => { e.stopPropagation(); this.toggleFavorite(r); }}>${r.favorite ? '★' : '☆'}</button><b style="font-weight:600">${r.name}</b></span></td>
          <td class="num" style="white-space:nowrap"><span class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap"><span class="tgt">${money(r.targetCents)}${r.targetCents ? html`<div class="muted small yearly" title="The monthly amount times 12">${money(r.targetCents * 12)} a year</div>` : nothing}</span><button class="icon edit" title="Change the monthly amount" aria-label="Edit monthly amount" @click=${(e: Event) => { e.stopPropagation(); this.openEdit(r); }}>✎</button></span></td>
          <td class="num ${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}" style="font-size:20px;font-weight:700">${money(r.currentCents)}</td>
          <td class="num">${money(r.kind === 'expense' ? r.spent[0] : r.gained[0])}</td><td class="num hide-sm muted">${money(r.kind === 'expense' ? r.spent[1] : r.gained[1])}</td>
          <td class="hide-sm" style="width:130px"><div class="bar ${r.spent[0] > r.targetCents ? 'over' : ''}"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div></td></tr>`)}</tbody></table></div>
      <div class="blist">${rows.map((r) => html`<div class="brow" role="link" tabindex="0" @click=${() => (location.hash = `#/categories/${r.id}`)}>
        <div class="brow-top"><button class="link icon bfav" title=${r.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${(e: Event) => { e.stopPropagation(); this.toggleFavorite(r); }}>${r.favorite ? '★' : '☆'}</button>
          <b class="brow-name">${r.name}</b><span class="brow-bal ${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}">${money(r.currentCents)}</span></div>
        <div class="brow-sub"><span>${r.kind === 'expense' ? 'Spent' : 'In'} ${money(r.kind === 'expense' ? r.spent[0] : r.gained[0])} of ${money(r.targetCents)}${r.targetCents ? html` <span class="muted small yearly">(${money(r.targetCents * 12)}/yr)</span>` : nothing}<button class="icon bedit" title="Change the monthly amount" aria-label="Edit monthly amount" @click=${(e: Event) => { e.stopPropagation(); this.openEdit(r); }}>✎</button></span><span>${r.kind === 'expense' ? `${money(r.spent[1])} last month` : ''}</span></div>
        ${r.kind === 'expense' ? html`<div class="bar ${r.spent[0] > r.targetCents ? 'over' : ''}"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div>` : nothing}</div>`)}</div></section>`;
  }
  openEdit(r: any) { this.editV = (r.targetCents / 100).toFixed(2); this.editM = new Date().toISOString().slice(0, 7); this.editing = r; }
  editDialog() {
    const r = this.editing; const cents = parseMoney(this.editV || '');
    return html`<dialog open><h2 style="margin-top:0">${r.name}: monthly amount</h2>
      <p class="muted">The old value is kept in this category's history timeline. Default is this month; pick an earlier month to restate history.</p>
      <div class="row"><input .value=${this.editV} @input=${(e: any) => (this.editV = e.target.value)} inputmode="decimal" aria-label="Monthly amount" /><input type="month" .value=${this.editM} @input=${(e: any) => (this.editM = e.target.value)} /></div>
      <p class="yearly-now" style="margin:8px 0 0" aria-live="polite">${Number.isFinite(cents) ? html`<b>${money(cents * 12)}</b> <span class="muted">a year (${money(cents)} × 12)</span>` : html`<span class="muted">Enter an amount to see the yearly total.</span>`}</p>
      <div class="row" style="margin-top:12px"><button @click=${() => (this.editing = null)}>Cancel</button><button class="primary" @click=${() => this.saveBudget(r, this.editV, this.editM)}>Save</button></div></dialog>`;
  }
}
