import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { pace, monthPace, today, type Cat } from '../shared.js';
import { pageHead, th, showDialog, catSelect, toast } from '../ui.js';
import { draw, theme, PALETTE } from '../charts.js';
import { weeklyCard, weeklyDialog } from '../weekly.js';

/** Whole dollars, for the yearly figure on a phone where width is tight. */
const whole = (c: number) => `$${Math.round(c / 100).toLocaleString('en-US')}`;

const NEGATIVE = 'Negative balance', OVER = 'Over monthly budget';
const GROUP_NOTE: Record<string, string> = {
  [NEGATIVE]: 'These envelopes are below $0. Move money into them (or recategorize the spending) to fix them.',
  [OVER]: 'Spent more than this month\'s amount but still have money. Often normal for envelopes used once a year or once a quarter.',
};

@customElement('hk-budget')
export class Budget extends Page {
  @state() data: any = null; @state() weekly: any[] = []; @state() view: 'table' | 'pie' = 'table'; @state() pieMode: 'allocated' | 'spent' = 'allocated'; @state() pie: any = null; @state() drill: string | null = null; @state() editing: any = null; @state() editV = ''; @state() editM = ''; @state() q = '';
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.data, this.weekly] = await Promise.all([api.get('/api/budget'), api.get('/api/weekly-budgets')]); this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }); }
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
  async toggleWeeklyFavorite(b: any) { await this.run(() => (b.favorite ? api.del(`/api/weekly-budgets/${b.id}/favorite`) : api.post(`/api/weekly-budgets/${b.id}/favorite`))); this.load(); }
  async editWeekly(b?: any) { if (await weeklyDialog(b)) this.load(); }
  weeklySection() {
    return html`<div class="row wk-bar"><h2 class="grow" style="margin:0">Weekly budgets</h2><button class="wk-new" @click=${() => this.editWeekly()}>＋ New weekly budget</button></div>
      ${this.weekly.length ? this.weekly.map((b) => weeklyCard(b, { favorite: () => this.toggleWeeklyFavorite(b), edit: () => this.editWeekly(b) })) : html`<p class="muted small" style="margin:0">A weekly budget spreads a monthly amount over the weeks of the month, so you can see what is left this week. A week that goes over eats into the next.</p>`}`;
  }
  async toggleFavorite(r: any) { await this.run(() => (r.favorite ? api.del(`/api/favorites/${r.id}`) : api.post('/api/favorites', { categoryId: r.id }))); this.load(); }
  render() {
    const d = this.data; if (!d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const h = d.header; const groups = new Map<string, any[]>();
    const needle = this.q.trim().toLowerCase();
    const matching = d.rows.filter((x: any) => !needle || x.name.toLowerCase().includes(needle) || (x.group ?? '').toLowerCase().includes(needle));
    const isNegative = (x: any) => x.currentCents < 0; // the envelope itself is below zero: needs fixing now
    const isOver = (x: any) => x.kind === 'expense' && x.spent[0] > x.targetCents; // the same test as the red pace bar: spent more than this month's amount, which can be normal for a yearly or quarterly envelope
    const negative = matching.filter(isNegative);
    const over = matching.filter((x: any) => !isNegative(x) && isOver(x));
    if (negative.length) groups.set(NEGATIVE, negative); // these lead the page, out of their usual groups; an envelope that is both appears only here
    if (over.length) groups.set(OVER, over);
    for (const r of matching.filter((x: any) => !isNegative(x) && !isOver(x))) (groups.get(r.group ?? 'Other') ?? groups.set(r.group ?? 'Other', []).get(r.group ?? 'Other')!).push(r);
    const unc = d.uncategorized;
    return html`${pageHead('Budget', 'Every envelope, grouped, with what you planned for it each month, what is left in it, and how this month is going. Money you do not spend stays in the envelope and rolls forward.', 'Click an envelope for a quick view: how this month is going, and a way to move money out of it. From there you can open its category page for history and transactions. Use the pencil to change a monthly amount; the old value is kept in its timeline. ☆ pins a category to Home.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="grid3 bstats">
        <div class="stat plan"><span class="label">Live plan</span><span class="value" style="font-size:20px">${h.livePlan ?? 'none'}</span></div>
        <div class="stat combo"><span class="label">Allocated / income (unallocated)</span>
          <span class="value"><span>${money(h.allocatedCents)}</span> <span class="of">/ ${money(h.incomeCents)}</span> <span class="un ${h.unallocatedCents < 0 ? 'neg' : 'pos'}">(${money(h.unallocatedCents)})</span></span>
          <span class="sub">per month; unallocated is income minus allocated</span></div></div>
      ${unc && unc.count ? html`<a class="stat" href="#/backlog"><span class="label">Needs category</span><span class="value ${unc.netCents < 0 ? 'neg' : ''}">${money(unc.netCents)}</span><span class="sub">${unc.count} transactions have no category yet, so they are not in any envelope below. Categorize them in the Backlog and each amount moves into its category.</span></a>` : nothing}
      ${this.weeklySection()}
      ${this.view === 'table' ? html`<input class="bsearch" type="search" placeholder="Find an envelope" aria-label="Find an envelope" .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} />` : nothing}
      <div class="tabs"><button aria-pressed=${this.view === 'table'} @click=${() => (this.view = 'table')}>Groups</button><button aria-pressed=${this.view === 'pie'} @click=${() => { this.view = 'pie'; this.drill = null; }}>Pie</button>
        ${this.view === 'pie' ? html`<button @click=${async () => { this.pieMode = this.pieMode === 'allocated' ? 'spent' : 'allocated'; this.drill = null; this.pie = await api.get(`/api/budget/pie?mode=${this.pieMode}`); }}>Share of ${this.pieMode} ↔</button>${this.drill ? html`<button @click=${() => (this.drill = null)}>← all groups</button>` : ''}` : ''}</div>
      ${this.view === 'pie' ? html`<div class="card"><div class="chart"></div><div class="muted">${this.drill ? this.drill : 'Click a group to drill into its categories.'}</div>${this.pieList()}</div>` : groups.size ? [...groups].map(([g, rows]) => this.group(g, rows)) : html`<p class="muted">No envelope matches "${this.q}".</p>`}
      ${this.editing ? this.editDialog() : ''}`;
  }
  group(name: string, rows: any[]) {
    return html`<section class="card flush group" data-group=${name}><div class="row" style="padding:16px 16px 8px"><h3 class="grow" style="font-size:19px">${name}</h3></div>
      ${GROUP_NOTE[name] ? html`<p class="muted small group-note" style="margin:0;padding:0 16px 8px">${GROUP_NOTE[name]}</p>` : nothing}
      <div class="btable" style="overflow-x:auto"><table style="font-size:16px"><thead><tr>${th('Category', 'The envelope. Click a row for a quick view.')}${th('Target', 'Monthly amount planned for this envelope. Use the pencil to change it.', 'num')}${th('Current', 'What is in the envelope now: everything accrued so far, minus spending, plus or minus transfers.', 'num')}${th('Spent (this)', 'Spent this period (net of refunds). For income categories this shows what came in.', 'num')}${th('Spent (last)', 'Same, for the previous period.', 'num hide-sm')}${th('Pace', 'Spent this period against the monthly target. Red means over.', 'hide-sm')}</tr></thead>
        <tbody>${rows.map((r) => html`<tr class="clickable" @click=${() => this.quickView(r)}>
          <td style="padding:12px"><span class="row" style="gap:8px"><button class="link icon fav" title=${r.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${(e: Event) => { e.stopPropagation(); this.toggleFavorite(r); }}>${r.favorite ? '★' : '☆'}</button><b style="font-weight:600">${r.name}</b></span></td>
          <td class="num" style="white-space:nowrap"><span class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap"><span class="tgt">${money(r.targetCents)}${r.targetCents ? html`<div class="muted small yearly" title="The monthly amount times 12">${money(r.targetCents * 12)} a year</div>` : nothing}</span><button class="icon edit" title="Change the monthly amount" aria-label="Edit monthly amount" @click=${(e: Event) => { e.stopPropagation(); this.openEdit(r); }}>✎</button></span></td>
          <td class="num ${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}" style="font-size:20px;font-weight:700">${money(r.currentCents)}</td>
          <td class="num">${money(r.kind === 'expense' ? r.spent[0] : r.gained[0])}</td><td class="num hide-sm muted">${money(r.kind === 'expense' ? r.spent[1] : r.gained[1])}</td>
          <td class="hide-sm" style="width:130px"><div class="bar ${r.spent[0] > r.targetCents ? 'over' : ''}"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div></td></tr>`)}</tbody></table></div>
      <div class="blist">${rows.map((r) => html`<div class="brow" role="button" tabindex="0" @click=${() => this.quickView(r)} @keydown=${(e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.quickView(r); } }}>
        <div class="brow-top"><button class="link icon bfav" title=${r.favorite ? 'Remove from Home favorites' : 'Pin to Home favorites'} aria-label="Toggle favorite" @click=${(e: Event) => { e.stopPropagation(); this.toggleFavorite(r); }}>${r.favorite ? '★' : '☆'}</button>
          <b class="brow-name">${r.name}</b><span class="brow-bal ${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}">${money(r.currentCents)}</span></div>
        <div class="brow-sub"><span class="brow-nums" title=${r.targetCents ? `${money(r.targetCents)} a month, ${money(r.targetCents * 12)} a year` : ''}>${money(r.kind === 'expense' ? r.spent[0] : r.gained[0])}/${money(r.targetCents)}${r.targetCents ? html` <span class="yearly">(${whole(r.targetCents * 12)}/yr)</span>` : nothing}</span><button class="icon bedit" title="Change the monthly amount" aria-label="Edit monthly amount" @click=${(e: Event) => { e.stopPropagation(); this.openEdit(r); }}>✎</button></div>
        <div class="bar ${r.kind === 'expense' && r.spent[0] > r.targetCents ? 'over' : ''}"><i style="width:${pace(r.kind === 'expense' ? r.spent[0] : r.gained[0], r.targetCents)}%"></i></div></div>`)}</div></section>`;
  }
  private cats: Cat[] | null = null;
  /**
   * The envelope's quick view: this month at a glance, a finer pace bar, and money moved out of it to another envelope.
   * Stays open after a move (with the new balance) so several can be made in a row.
   */
  async quickView(r0: any) {
    this.cats ??= await this.run(() => api.get('/api/categories')) ?? null;
    const cats = (this.cats ?? []).filter((c) => c.id !== r0.id);
    let r = r0, to: number | null = null, amount = '', memo = '', err = '', busy = false;
    const cents = () => { const c = parseMoney(amount || ''); return Number.isFinite(c) && c > 0 ? c : 0; };
    await showDialog<void>((close, update) => {
      const expense = r.kind === 'expense', spent = expense ? r.spent[0] : r.gained[0], target = r.targetCents;
      const p = monthPace(spent, target, today()), scale = Math.max(target, spent, 1);
      const state = !target ? 'none' : spent > target ? 'over' : p.delta > 0 ? 'ahead' : 'ok';
      const verdict = !target ? `No monthly amount is set for ${r.name}.`
        : expense ? (p.delta > 0 ? `${money(p.delta)} ahead of pace: an even pace would have spent ${money(p.expected)} by now.` : `${money(-p.delta)} under pace (an even pace would have spent ${money(p.expected)} by now): on track.`)
        : (p.delta >= 0 ? `${money(p.delta)} ahead of pace: on track.` : `${money(-p.delta)} behind pace (an even pace would have ${money(p.expected)} by now).`);
      const send = async () => {
        if (!to || !cents() || busy) return;
        busy = true; err = ''; update();
        try {
          await api.post('/api/transfers/manual', { from: r.id, to, cents: cents(), memo });
          toast(`Moved ${money(cents())} from ${r.name} to ${cats.find((c) => c.id === to)?.name ?? 'the other envelope'}`);
          amount = ''; memo = '';
          await this.load();
          r = this.data?.rows.find((x: any) => x.id === r.id) ?? r;
        } catch (e) { err = (e as Error).message; }
        busy = false; update();
      };
      return html`<div class="qv">
        <div class="row"><h2 class="grow">${r.name}</h2>${r.group ? html`<span class="muted small">${r.group}</span>` : nothing}</div>
        <div class="qv-line"><b class="qv-spent">${money(spent)} / ${money(target)}</b><span class="muted">${expense ? 'spent' : 'received'} this month</span></div>
        ${target ? html`<div class="muted qv-yearly">${money(target * 12)} a year <span class="small">(${money(target)} × 12)</span></div>` : nothing}
        <div class="qv-pace ${state}" role="img" aria-label=${verdict}><div class="qv-track"><i class="qv-spentbar" style="width:${pace(spent, scale)}%"></i>${target ? html`<i class="qv-marker" title="Where an even pace would be today" style="left:${Math.min(100, (p.expected / scale) * 100)}%"></i>` : nothing}${target && spent > target ? html`<i class="qv-target" title="Monthly amount" style="left:${(target / scale) * 100}%"></i>` : nothing}</div></div>
        <p class="qv-pace-note"><span class="muted">Day ${p.day} of ${p.days}.</span> ${verdict}${target && expense && spent > 0 ? html` <span class="muted">At this rate: ${money(p.projected)} by month end${p.projected > target ? `, ${money(p.projected - target)} over` : ''}.</span>` : nothing}</p>
        <div class="qv-balance">In the envelope now: <b class=${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}>${money(r.currentCents)}</b></div>
        <h3 class="qv-h">Move money out of ${r.name}</h3>
        <div class="qv-transfer"><div class="qv-to">${catSelect(cats, to, (id) => { to = id; update(); }, { placeholder: 'To envelope' })}</div>
          <input class="qv-amount" placeholder="0.00" inputmode="decimal" aria-label="Amount" .value=${amount} @input=${(e: any) => { amount = e.target.value; update(); }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') send(); }} />
          <input class="qv-memo" placeholder="Memo (optional)" aria-label="Memo" .value=${memo} @input=${(e: any) => (memo = e.target.value)} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') send(); }} />
          <button class="primary qv-move" ?disabled=${!to || !cents() || busy} title=${!to || !cents() ? 'Pick the envelope to move it to and an amount above $0' : ''} @click=${send}>Move</button></div>
        ${err ? html`<p class="err">${err}</p>` : nothing}
        <div class="actions"><a class="qv-open" href="#/categories/${r.id}" @click=${() => close()}>Open the ${r.name} category page →</a><span class="grow"></span><button class="qv-close" @click=${() => close()}>Close</button></div></div>`;
    }, { className: 'quickview' });
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
