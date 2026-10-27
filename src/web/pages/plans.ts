import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { thisMonth } from '../shared.js';
import { pageHead, th, showDialog } from '../ui.js';
import { draw, theme, PALETTE } from '../charts.js';

const monthLabel = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
const nextOf = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const whenIs = (m: string, now: string) => (m === now ? 'this month' : m < now ? 'a past month' : m === nextOf(now) ? 'next month' : 'a future month');
const phaseText = (p: any) => (p.phase === 'scheduled' ? `scheduled · ${p.effective_month}` : p.phase);
const planId = () => Number(location.hash.split('/')[2]) || null;

@customElement('hk-plans')
export class Plans extends Page {
  @state() plans: any[] = []; @state() scenarios: any[] = []; @state() cur: any = null; @state() diff: any = null; @state() month = thisMonth(); @state() confirmText = ''; @state() drill: string | null = null;
  private onHash = () => { this.cur = null; this.diff = null; this.drill = null; void this.load(); };
  connectedCallback() { super.connectedCallback(); addEventListener('hashchange', this.onHash); void this.load(); }
  disconnectedCallback() { removeEventListener('hashchange', this.onHash); super.disconnectedCallback(); }
  async load() {
    await this.run(async () => {
      const id = planId();
      [this.plans, this.scenarios] = await Promise.all([api.get('/api/plans'), api.get('/api/scenarios')]);
      this.cur = id ? await api.get(`/api/plans/${id}`) : null;
    });
  }
  updated() { if (this.cur) this.drawPie(); }
  async create(from: string, fromPlanId?: number) { const name = prompt('Plan name?', 'New plan'); if (!name) return; await this.run(async () => { const r = await api.post('/api/plans', { name, from, fromPlanId }); location.hash = `#/plans/${r.id}`; }); }
  async setItem(catId: number, v: string) { await this.run(() => api.put(`/api/plans/${this.cur.plan.id}/items/${catId}`, { monthlyCents: parseMoney(v) })); await this.load(); }
  async showDiff() { await this.run(async () => { this.diff = await api.get(`/api/plans/${this.cur.plan.id}/diff?month=${this.month}`); this.confirmText = ''; }); }
  async go() { await this.run(async () => { await api.post(`/api/plans/${this.cur.plan.id}/make-live`, { effectiveMonth: this.month, confirmRestate: this.confirmText }); this.diff = null; await this.load(); }); }
  async removeAction(id: number) { await this.run(() => api.del(`/api/plans/${this.cur.plan.id}/actions/${id}`)); await this.load(); }

  render() {
    return html`${this.cur ? this.detail() : this.list()}${this.diff ? this.confirmDialog() : nothing}`;
  }

  /* ---------- the list: a plain table ---------- */
  list() {
    return html`${pageHead('Plans', 'A plan is a complete monthly budget you can draft safely and then make live. Changing a monthly amount for one category is done on the Budget page; plans are for changing many at once.', 'Open a plan to see it grouped like the Budget, with a pie chart. Before a plan goes live you see exactly what changes and why. A plan can go live this month, or be scheduled for a later one; going live for a past month restates history and asks you to confirm.')}${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="row" style="margin-bottom:10px"><button class="primary" @click=${() => this.create('live')}>＋ New from live</button><button @click=${() => this.create('blank')}>＋ Blank</button></div>
      <div class="card flush" style="overflow-x:auto"><table class="plans-table"><thead><tr>${th('Plan', 'The name of the plan. Click a row to open it.')}${th('Status', 'Draft: still being edited. Live: the budget in force now. Scheduled: made live for a later month. Archived: replaced by a newer plan.')}${th('Income', 'Monthly take-home income the plan assumes (its earnings scenario).', 'num hide-sm')}${th('Allocated', 'The total of all monthly amounts in the plan.', 'num')}${th('Unallocated', 'Income minus allocated. Negative means the plan spends more than it earns.', 'num hide-sm')}${th('Goes live', 'The month this plan\'s amounts take effect.')}<th></th></tr></thead>
        <tbody>${this.plans.map((p) => html`<tr class="clickable" @click=${() => (location.hash = `#/plans/${p.id}`)}>
          <td class="pname"><b>${p.name}</b></td><td><span class="badge ${p.phase === 'live' ? 'good' : 'warn'}">${phaseText(p)}</span></td>
          <td class="num hide-sm">${money(p.incomeCents)}</td><td class="num">${money(p.allocatedCents)}</td><td class="num hide-sm ${p.unallocatedCents < 0 ? 'neg' : ''}">${money(p.unallocatedCents)}</td>
          <td>${p.effective_month ?? '—'}</td>
          <td class="num">${p.status !== 'draft' ? html`<button @click=${(e: Event) => { e.stopPropagation(); this.create('plan', p.id); }}>Clone</button>` : nothing}</td></tr>`)}</tbody></table></div>`;
  }

  /* ---------- one plan ---------- */
  groups() {
    const m = new Map<string, any[]>();
    for (const i of this.cur.items) if (i.kind === 'expense') (m.get(i.group_name ?? 'Other') ?? m.set(i.group_name ?? 'Other', []).get(i.group_name ?? 'Other')!).push(i);
    return [...m].map(([name, items]) => ({ name, items, cents: items.reduce((t, i) => t + i.monthly_cents, 0) }));
  }
  drawPie() {
    const el = this.querySelector('.chart') as HTMLElement | null; if (!el) return;
    const groups = this.groups().filter((g) => g.cents > 0).sort((a, b) => b.cents - a.cents);
    const g = this.drill ? groups.find((x) => x.name === this.drill) : null;
    const narrow = el.clientWidth < 520; // phones: the list under the chart names the slices
    const data = g ? g.items.filter((i: any) => i.monthly_cents > 0).map((i: any) => ({ name: i.name, value: i.monthly_cents })) : groups.map((x) => ({ name: x.name, value: x.cents }));
    void draw(el, { tooltip: { formatter: (p: any) => `${p.name}: ${money(p.value)} (${p.percent}%)` }, series: [{ type: 'pie', radius: narrow ? ['38%', '85%'] : ['35%', '70%'], data, label: narrow ? { show: false } : { formatter: '{b}\n{d}%', color: theme().ink }, labelLine: narrow ? { show: false } : { lineStyle: { color: theme().muted } } }] },
      (p: any) => { if (!this.drill) this.drill = p.name; });
  }
  pieCard() {
    const groups = this.groups().filter((g) => g.cents > 0).sort((a, b) => b.cents - a.cents);
    const g = this.drill ? groups.find((x) => x.name === this.drill) : null;
    const rows: { name: string; cents: number }[] = g ? g.items.filter((i: any) => i.monthly_cents > 0).map((i: any) => ({ name: i.name, cents: i.monthly_cents })).sort((a: any, b: any) => b.cents - a.cents) : groups.map((x) => ({ name: x.name, cents: x.cents }));
    const total = rows.reduce((t, i) => t + i.cents, 0) || 1;
    if (!rows.length) return html`<div class="card muted">Nothing is budgeted in this plan yet.</div>`;
    return html`<div class="card"><div class="row"><b class="grow">Where the plan's money goes</b>${this.drill ? html`<button @click=${() => (this.drill = null)}>← all groups</button>` : nothing}</div>
      <div class="chart"></div><div class="muted">${this.drill ? this.drill : 'Click a group to drill into its categories.'}</div>
      <div class="pielist">${rows.map((i, n) => html`<button class="pierow" ?disabled=${!!g} @click=${() => { if (!g) this.drill = i.name; }}><i style="background:${PALETTE[n % PALETTE.length]}"></i><span class="pn">${i.name}</span><span class="pa">${money(i.cents)}</span><span class="pp">${Math.round((i.cents / total) * 1000) / 10}%</span></button>`)}</div></div>`;
  }
  detail() {
    const c = this.cur; const p = c.plan; const draft = p.status === 'draft'; const h = c.header;
    const canGo = c.phase === 'draft' || c.phase === 'archived';
    return html`<div class="plan-back"><a href="#/plans">← Plans</a></div>
      ${pageHead(p.name, 'This plan as a budget: every category with its monthly amount, grouped, and a pie of where the money goes. A draft can be edited; make it live to start using it.', 'Add moves or retirements under "At go-live" and they happen once, together with the plan, in the month you pick.')}${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="row" style="margin-bottom:10px"><span class="badge plan-phase ${c.phase === 'live' ? 'good' : 'warn'}">${phaseText({ phase: c.phase, effective_month: p.effective_month })}</span>
        ${p.status !== 'draft' ? html`<button @click=${() => this.create('plan', p.id)}>Clone</button>` : nothing}</div>
      <div class="grid3 bstats pstats">
        <div class="stat combo"><span class="label">Allocated / income (unallocated)</span><span class="value"><span>${money(h.allocatedCents)}</span> <span class="of">/ ${money(h.incomeCents)}</span> <span class="un ${h.unallocatedCents < 0 ? 'neg' : 'pos'}">(${money(h.unallocatedCents)})</span></span><span class="sub">per month; unallocated is income minus allocated</span></div>
        <div class="stat plan"><span class="label">Earnings</span><select aria-label="Earnings scenario" ?disabled=${!draft} @change=${async (e: any) => { await this.run(() => api.put(`/api/plans/${p.id}/scenario`, { scenarioId: Number(e.target.value) || null })); await this.load(); }}>
          <option value="">none</option>${this.scenarios.map((s) => html`<option value=${s.id} ?selected=${s.id === p.scenario_id}>${s.name} (${money(s.monthlyNetCents)}/mo)</option>`)}</select></div></div>
      ${h.overAllocated ? html`<div class="badge bad" style="margin-bottom:8px">Over-allocated (warning only)</div>` : nothing}
      ${this.pieCard()}
      ${this.groups().map((g) => this.group(g, draft))}
      ${this.actionsCard(draft)}
      ${canGo ? html`<div class="card"><b>Make this plan live</b><p class="muted small" style="margin:4px 0 8px">Pick the month it takes effect. This month starts it now; a later month schedules it and changes nothing until then.</p>
        <div class="row"><input type="month" aria-label="Go-live month" .value=${this.month} @change=${(e: any) => (this.month = e.target.value)} /><button class="primary" @click=${() => this.showDiff()}>Make live…</button></div></div>` : nothing}`;
  }
  group(g: { name: string; items: any[]; cents: number }, draft: boolean) {
    return html`<section class="card flush group" data-group=${g.name}><div class="row" style="padding:16px 16px 8px"><h3 class="grow" style="font-size:19px">${g.name} <span class="muted small">${money(g.cents)} a month</span></h3></div>
      <div style="overflow-x:auto"><table><tbody>${g.items.map((i) => html`<tr class="prow"><td class="cname">${i.name}</td>
        <td class="num">${draft ? html`<input style="width:7rem;text-align:right" aria-label="Monthly amount for ${i.name}" inputmode="decimal" .value=${(i.monthly_cents / 100).toFixed(2)} @change=${(e: any) => this.setItem(i.category_id, e.target.value)} />` : money(i.monthly_cents)}</td>
        <td class="num muted small yearly">${i.monthly_cents ? `${money(i.monthly_cents * 12)} a year` : ''}</td></tr>`)}</tbody></table></div></section>`;
  }

  /* ---------- moves and retirements that happen when the plan goes live ---------- */
  actionsCard(draft: boolean) {
    const acts: any[] = this.cur.actions;
    if (!draft && !acts.length) return nothing;
    return html`<div class="card plan-actions"><b>At go-live</b>
      <p class="muted small" style="margin:4px 0 8px">${draft ? 'Things that happen once, together with the plan, dated the first of the go-live month: move money from one category to another, or retire a category.' : 'These happened once, when the plan went live.'}</p>
      ${acts.map((a) => html`<div class="row paction"><span class="grow">${a.kind === 'move' ? html`Move <b>${money(a.cents)}</b> from <b>${a.name}</b> to <b>${a.to_name}</b>` : html`Retire <b>${a.name}</b>${a.to_name ? html`, moving what is left to <b>${a.to_name}</b>` : ', leaving what is left in it'}`}</span>
        ${draft ? html`<button class="icon rm-action" title="Remove" aria-label="Remove this action" @click=${() => this.removeAction(a.id)}>✕</button>` : nothing}</div>`)}
      ${draft ? html`<div class="row" style="margin-top:8px"><button class="add-move" @click=${() => this.addMove()}>＋ Move money</button><button class="add-retire" @click=${() => this.addRetire()}>＋ Retire a category</button></div>` : nothing}</div>`;
  }
  async pickable() {
    const all: any[] = await api.get('/api/categories');
    return all.filter((c) => c.status === 'active' && !c.system && c.kind !== 'income_reference');
  }
  options(cats: any[]) {
    const g = new Map<string, any[]>(); for (const c of cats) (g.get(c.group_name ?? 'Other') ?? g.set(c.group_name ?? 'Other', []).get(c.group_name ?? 'Other')!).push(c);
    return [...g].map(([name, list]) => html`<optgroup label=${name}>${list.map((c) => html`<option value=${c.id}>${c.name} (${money(c.balance_cents ?? 0)})</option>`)}</optgroup>`);
  }
  async addMove() {
    const cats = await this.pickable(); const f = { from: 0, to: 0, amount: '', err: '' };
    const ok = await showDialog<boolean>((close, update) => {
      const cents = f.amount ? parseMoney(f.amount) : NaN;
      const valid = f.from && f.to && f.from !== f.to && Number.isFinite(cents) && cents > 0;
      return html`<h3 class="title">Move money at go-live</h3><p class="muted">Moves this much from one envelope to another on the first of the go-live month. Nothing moves until the plan goes live.</p>
        <div class="stack"><label class="stack" style="gap:4px">From<select aria-label="From" @change=${(e: any) => { f.from = Number(e.target.value); update(); }}><option value="">Choose…</option>${this.options(cats)}</select></label>
          <label class="stack" style="gap:4px">To<select aria-label="To" @change=${(e: any) => { f.to = Number(e.target.value); update(); }}><option value="">Choose…</option>${this.options(cats)}</select></label>
          <label class="stack" style="gap:4px">Amount<input aria-label="Amount" inputmode="decimal" placeholder="0.00" .value=${f.amount} @input=${(e: any) => { f.amount = e.target.value; update(); }} /></label>
          ${f.err ? html`<p class="err" role="alert">${f.err}</p>` : nothing}</div>
        <div class="actions"><button @click=${() => close(false)}>Cancel</button><button class="primary" ?disabled=${!valid} @click=${async () => {
          try { await api.post(`/api/plans/${this.cur.plan.id}/actions`, { kind: 'move', fromCategoryId: f.from, toCategoryId: f.to, cents }); close(true); } catch (e) { f.err = (e as Error).message; update(); } }}>Add move</button></div>`;
    }, { dismiss: false });
    if (ok) await this.load();
  }
  async addRetire() {
    const cats = await this.pickable(); const taken = new Set(this.cur.actions.filter((a: any) => a.kind === 'retire').map((a: any) => a.category_id));
    const f = { cat: 0, to: 0, err: '' };
    const ok = await showDialog<boolean>((close, update) => html`<h3 class="title">Retire a category at go-live</h3><p class="muted">Its monthly amount drops to zero from the go-live month and it stops appearing in pickers. History stays. It can only be retired in the current month or an earlier one, and not while it is overspent.</p>
        <div class="stack"><label class="stack" style="gap:4px">Category<select aria-label="Category" @change=${(e: any) => { f.cat = Number(e.target.value); update(); }}><option value="">Choose…</option>${this.options(cats.filter((c) => !taken.has(c.id)))}</select></label>
          <label class="stack" style="gap:4px">Move what is left to<select aria-label="Move what is left to" @change=${(e: any) => { f.to = Number(e.target.value); update(); }}><option value="">Leave it in the category</option>${this.options(cats.filter((c) => c.id !== f.cat))}</select></label>
          ${f.err ? html`<p class="err" role="alert">${f.err}</p>` : nothing}</div>
        <div class="actions"><button @click=${() => close(false)}>Cancel</button><button class="primary" ?disabled=${!f.cat} @click=${async () => {
          try { await api.post(`/api/plans/${this.cur.plan.id}/actions`, { kind: 'retire', categoryId: f.cat, moveBalanceTo: f.to || null }); close(true); } catch (e) { f.err = (e as Error).message; update(); } }}>Add retirement</button></div>`, { dismiss: false });
    if (ok) await this.load();
  }

  /* ---------- the go-live dialog: what changes, and why ---------- */
  confirmDialog() {
    const d = this.diff; const name = this.cur.plan.name; const n = d.historyEntries;
    const when = whenIs(d.effectiveMonth, d.currentMonth); const future = d.effectiveMonth > d.currentMonth;
    const blocked = d.blockers.length > 0 || (d.retroactive && this.confirmText !== 'RESTATE');
    return html`<dialog open><h2 style="margin-top:0">Make "${name}" live</h2>
      ${d.staleBase ? html`<p class="badge warn">Live changed after this draft was created; diff is against current live.</p>` : nothing}
      <p class="golive-when">Takes effect <b>${monthLabel(d.effectiveMonth)}</b> (${d.effectiveMonth}), ${when}. ${future ? html`<b>Nothing changes today.</b> The budget in force now stays in force, and no envelope balance moves, until that month begins.` : d.retroactive ? html`That month is already over, so history is restated.` : html`That month has already started, so it applies from now.`}</p>
      <p>Income ${d.incomeOld === null ? '—' : money(d.incomeOld)} → <b>${money(d.incomeNew)}</b>. Allocated ${money(d.allocatedOld)} → ${money(d.allocatedNew)} (unallocated ${money(d.unallocatedNew)}).</p>
      <p><b>${n}</b> history ${n === 1 ? 'entry' : 'entries'} will be created.</p>
      ${n ? html`<p class="muted small"><b>Why:</b> ${n === 1 ? 'this category has' : 'these categories have'} a different monthly amount in the plan than the budget in force for ${d.effectiveMonth}. Anything not listed already matches. ${d.touchesBalances && !d.retroactive ? html`Because ${d.effectiveMonth} has already started, its share of each change is added to or taken from the envelope's balance (Balance Δ); money already spent is not touched.` : nothing}</p>
      <div class="diff-wrap"><table class="diff-table"><thead><tr>${th('Category', 'A category whose monthly amount changes.')}${th('Old', 'Monthly amount before this plan.', 'num')}${th('New', 'Monthly amount if you go live.', 'num')}${th('Δ', 'New minus old.', 'num')}${d.touchesBalances ? th('Balance Δ', 'How much this category\'s current balance changes because the go-live month\'s (and any earlier months\') budget changes.', 'num') : nothing}</tr></thead><tbody>
        ${d.rows.map((r: any) => html`<tr><td>${r.name}${r.retiring ? html` <span class="badge warn">retiring</span>` : nothing}</td><td class="num">${money(r.oldCents)}</td><td class="num">${money(r.newCents)}</td><td class="num">${money(r.deltaCents, { sign: true })}</td>${d.touchesBalances ? html`<td class="num">${money(r.restatedBalanceDeltaCents, { sign: true })}</td>` : nothing}</tr>`)}</tbody></table></div>` : html`<p class="muted small">No category's monthly amount changes.</p>`}
      ${d.moves.length ? html`<h3 style="margin:14px 0 4px">Move money</h3>${d.moves.map((m: any) => html`<div class="gl-line"><b>${money(m.cents)}</b> from ${m.fromName} to ${m.toName}, dated ${m.date}.
        <div class="muted small">${m.fromName} will hold ${money(m.fromAfterCents)}; ${m.toName} will hold ${money(m.toAfterCents)}.</div>${m.warning ? html`<div class="err small">${m.warning}</div>` : nothing}</div>`)}` : nothing}
      ${d.retires.length ? html`<h3 style="margin:14px 0 4px">Retire</h3>${d.retires.map((r: any) => html`<div class="gl-line"><b>${r.name}</b> is retired from ${d.effectiveMonth}; its monthly amount drops to $0.00.
        ${r.canRetire ? html`<div class="muted small">${money(r.leftoverCents)} will be left in it${r.moveToName ? html`, and moves to ${r.moveToName}` : ' and stays there'}.${r.rulesOff ? ` ${r.rulesOff} rule${r.rulesOff === 1 ? '' : 's'} that file into it will be turned off.` : ''}</div>` : html`<div class="err small">${r.reason}</div>`}</div>`)}` : nothing}
      ${d.retroactive ? html`<p class="err"><b>This restates history.</b> Balances change as shown. Type RESTATE to confirm.</p><input aria-label="Type RESTATE" .value=${this.confirmText} @input=${(e: any) => (this.confirmText = e.target.value)} />` : nothing}
      <div class="row" style="margin-top:12px"><button @click=${() => (this.diff = null)}>Cancel</button><button class="primary" ?disabled=${blocked} @click=${() => this.go()}>Confirm</button></div></dialog>`;
  }
}
