import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { thisMonth, ruleSummary, type Cat } from '../shared.js';
import { pageHead, th, catSelect, showDialog, toast, withBusy } from '../ui.js';

const balClass = (c: number | null | undefined) => (c == null ? 'muted' : c < 0 ? 'neg' : c > 0 ? 'pos' : '');
const ruleLine = (r: any) => html`<div class="cat-rule">${ruleSummary(r)} <span class="badge">${r.mode}</span>${r.enabled ? nothing : html` <span class="badge warn">off</span>`}</div>`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

@customElement('hk-categories')
export class Categories extends Page {
  @state() cats: any[] = []; @state() detail: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); addEventListener('hashchange', () => this.route()); }
  async load() { await this.run(async () => { this.cats = await api.get('/api/categories'); await this.route(); }); }
  async route() { const id = Number(location.hash.split('/')[2]); this.detail = id ? await api.get(`/api/categories/${id}`) : null; }
  render() {
    if (this.detail) return this.detailView();
    return html`${pageHead('Categories', 'Every envelope you can put a transaction in. Add new ones, tune how they behave when money gets tight, and retire the ones you no longer use.', 'A new category is an empty envelope with no money attached: give it a monthly amount in a plan (or with the pencil on the Budget page) and it shows up there. Retiring keeps all history and sets the monthly amount to zero going forward; an overspent envelope cannot retire until it is back at $0. Unretire brings a category back with its last monthly amount. Cushion and priority control how overspending is covered during a rebalance.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><button class="primary add-category" @click=${() => this.add()}>＋ Add category</button></div>
      <div class="card" style="overflow-x:auto"><table><thead><tr>${th('Category', 'Click a name for its balance, budget history and transactions.')}${th('Group', 'Where it appears on the Budget page.')}${th('Balance', 'What is in the envelope right now: everything accrued so far, minus spending, plus or minus transfers. Check it before retiring a category.', 'num')}${th('Discretionary', 'Only discretionary envelopes ever give money to cover overspending. A non-discretionary one (mortgage, insurance…) is never drawn on.')}${th('Cushion', 'Discretionary envelopes only. Kept ABOVE this month\'s budget when covering overspending: with a $150 budget and a $50 cushion, money is only taken from the envelope when it holds more than $200, and only the excess. Empty counts as 0: the envelope keeps exactly its budget. Non-discretionary envelopes never give, so they have no cushion.', 'num')}${th('Priority', 'When several envelopes are overspent, lower numbers are covered first.', 'num')}<th></th></tr></thead><tbody>${this.cats.filter((c) => !c.system).map((c) => html`<tr style=${c.status === 'retired' ? 'opacity:.5' : ''}><td><a href="#/categories/${c.id}" style="color:inherit;font-weight:600;text-decoration:none">${c.name}</a> ${c.status === 'retired' ? html`<span class="badge">retired</span>` : ''}</td><td>${c.group_name ?? ''}</td><td class="num ${balClass(c.balance_cents)}">${money(c.balance_cents)}</td>
        <td><input type="checkbox" .checked=${!!c.discretionary} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { discretionary: e.target.checked }); this.load(); }} /></td>
        <td class="num"><input style="width:6rem;text-align:right" .value=${c.cushion_cents == null ? '' : (c.cushion_cents / 100).toFixed(2)} placeholder="0" aria-label="Cushion above the budget" ?disabled=${!c.discretionary} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { cushionCents: e.target.value === '' ? null : parseMoney(e.target.value) }); this.load(); }} />${c.kind !== 'expense' ? '' : !c.discretionary ? html`<div class="muted small never" title="Non-discretionary envelopes are never drawn on to cover overspending">never gives</div>` : html`<div class="muted small keeps" title="Budget plus cushion (an empty cushion counts as 0)">keeps ${money(c.monthly_cents + (c.cushion_cents ?? 0))}</div>`}</td>
        <td class="num"><input style="width:3.5rem;text-align:right" .value=${c.overage_priority ?? ''} @change=${async (e: any) => { await api.patch(`/api/categories/${c.id}`, { overagePriority: e.target.value === '' ? null : Number(e.target.value) }); this.load(); }} /></td>
        <td>${c.status === 'active' ? html`<button class="retire" ?disabled=${(c.balance_cents ?? 0) < 0} title=${(c.balance_cents ?? 0) < 0 ? `Overspent by ${money(-c.balance_cents)}: bring it back to $0 or more before retiring` : 'Retire this category'} @click=${() => this.retire(c)}>Retire</button>` : c.status === 'retired' && c.name.toLowerCase() !== 'needs category' ? html`<button class="unretire primary" @click=${() => this.unretire(c)}>Unretire</button>` : ''}</td></tr>`)}</tbody></table></div>`;
  }
  /** A dialog, not an inline form: it names what you are making, stays up (with the reason) when a name is taken, and ends with a toast. */
  async add() {
    const f = { name: '', group: '', startMonth: thisMonth(), err: '' };
    const groups = [...new Set(this.cats.map((c) => c.group_name).filter(Boolean))].sort();
    const added = await showDialog<string>((close, update) => {
      const submit = async () => {
        if (!f.name.trim()) return;
        try {
          const name = f.name.trim();
          await withBusy('Saving…', () => api.post('/api/categories', { name, group: f.group.trim() || undefined, startMonth: f.startMonth }));
          close(name);
        } catch (e) { f.err = (e as Error).message; update(); document.querySelector<HTMLInputElement>('dialog input[aria-label="Name"]')?.select(); }
      };
      return html`<h3 class="title">Add a category</h3>
        <p class="muted">A new category is an empty envelope. It joins the Budget page once you give it a monthly amount in a plan.</p>
        <div class="stack">
          <label class="stack" style="gap:4px">Name<input aria-label="Name" autocomplete="off" .value=${f.name} @input=${(e: any) => { f.name = e.target.value; f.err = ''; update(); }} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void submit(); }} /></label>
          <label class="stack" style="gap:4px">Group (optional)<input aria-label="Group" list="cat-groups" autocomplete="off" .value=${f.group} @input=${(e: any) => (f.group = e.target.value)} @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void submit(); }} /><datalist id="cat-groups">${groups.map((g) => html`<option value=${g}></option>`)}</datalist></label>
          <label class="stack" style="gap:4px">First month<input aria-label="First month" type="month" .value=${f.startMonth} @input=${(e: any) => (f.startMonth = e.target.value)} /></label>
          ${f.err ? html`<p class="err add-error" role="alert"><b>Not added.</b> ${f.err}</p>` : nothing}
        </div>
        <div class="actions"><button @click=${() => close(undefined)}>Cancel</button><button class="primary" ?disabled=${!f.name.trim()} @click=${submit}>Add category</button></div>`;
    }, { dismiss: false });
    if (added) { toast(`Added category "${added}"`); await this.load(); }
  }
  async retire(c: any) {
    const d = await this.run(() => api.get(`/api/categories/${c.id}`)); if (!d) return;
    const p = d.retire; const rules: any[] = d.rules;
    const f: { to: number | null; rules: boolean } = { to: null, rules: true };
    const others = this.cats.filter((x) => x.id !== c.id);
    const ok = await showDialog<boolean>((close, update) => {
      const dest = f.to ? this.cats.find((x) => x.id === f.to) : null;
      return html`<h3 class="title">Retire ${c.name}?</h3><p class="muted">History stays. Its monthly amount drops to zero from this month. Anything left in the envelope can move to another category now, or stay put.</p>
        <p class="retire-balance">Left in ${c.name} when it retires: <b class=${balClass(p.afterCents)}>${money(p.afterCents)}</b>${p.afterCents !== p.currentCents ? html` <span class="muted small">(${money(p.currentCents)} today, before this month's budget stops)</span>` : nothing}</p>
        ${p.canRetire ? nothing : html`<p class="err retire-blocked" role="alert"><b>Cannot retire.</b> ${p.reason}</p>`}
        <label class="stack" style="gap:4px">Move the remaining balance to (optional)${catSelect(others, f.to, (id) => { f.to = id; update(); }, { placeholder: 'Type to search, or leave empty to keep it' })}</label>
        ${dest ? html`<p class="dest-balance muted">${dest.name} has ${money(dest.balance_cents)}${p.afterCents ? html` and would have <b>${money((dest.balance_cents ?? 0) + p.afterCents)}</b>` : nothing}.</p>` : nothing}
        <div class="retire-rules"><b>Rules that file into ${c.name}</b>${rules.length ? rules.map(ruleLine) : html`<div class="muted small">None.</div>`}
          ${rules.some((r) => r.enabled) ? html`<label class="row"><input class="disable-rules" type="checkbox" .checked=${f.rules} @change=${(e: any) => (f.rules = e.target.checked)} /> <span>Turn off ${rules.filter((r) => r.enabled).length === 1 ? 'this rule' : `these ${rules.filter((r) => r.enabled).length} rules`}, so nothing new lands in a retired category</span></label>` : nothing}</div>
        <div class="actions"><button @click=${() => close(false)}>Cancel</button><button class="primary danger-solid confirm" ?disabled=${!p.canRetire} @click=${() => close(true)}>Retire</button></div>`;
    }, { dismiss: false });
    if (!ok) return;
    const r = await this.run(() => api.post(`/api/categories/${c.id}/retire`, { moveBalanceTo: f.to ?? undefined, disableRules: f.rules && rules.some((x) => x.enabled) }));
    if (r) toast([`Retired ${c.name}`, f.to && r.remainingCents ? `${money(r.remainingCents)} moved to ${this.cats.find((x) => x.id === f.to)?.name}` : '', r.rulesDisabled ? `${plural(r.rulesDisabled, 'rule')} turned off` : ''].filter(Boolean).join('. '));
    await this.load();
  }
  async unretire(c: any) {
    const d = await this.run(() => api.get(`/api/categories/${c.id}`)); if (!d) return;
    const rules: any[] = d.rules; const off = rules.filter((r) => !r.enabled);
    let on = true;
    const ok = await showDialog<boolean>((close) => html`<h3 class="title">Unretire ${c.name}?</h3><p>It comes back as an active category with the last monthly amount it had, starting this month. Months while it was retired stay at zero.</p>
        <div class="retire-rules"><b>Rules that file into ${c.name}</b>${rules.length ? rules.map(ruleLine) : html`<div class="muted small">None.</div>`}
          ${off.length ? html`<label class="row"><input class="enable-rules" type="checkbox" .checked=${on} @change=${(e: any) => (on = e.target.checked)} /> <span>Turn ${off.length === 1 ? 'this rule' : `these ${off.length} rules`} back on</span></label>` : nothing}</div>
        <div class="actions"><button class="cancel" @click=${() => close(false)}>Cancel</button><button class="primary confirm" autofocus @click=${() => close(true)}>Unretire</button></div>`, { dismiss: false });
    if (!ok) return;
    const r = await this.run(() => api.post(`/api/categories/${c.id}/unretire`, { enableRules: on && off.length > 0 }));
    if (r) toast([`Unretired ${c.name}`, r.rulesEnabled ? `${plural(r.rulesEnabled, 'rule')} turned back on` : ''].filter(Boolean).join('. '));
    await this.load();
  }
  detailView() {
    const d = this.detail; const c = d.category;
    return html`<div class="row"><a href="#/categories">← Categories</a>${c.status === 'retired' && c.name.toLowerCase() !== 'needs category' ? html`<button class="unretire primary right" @click=${() => this.unretire(c)}>Unretire</button>` : nothing}</div><h1>${c.name} ${c.status === 'retired' ? html`<span class="badge">retired</span>` : nothing}</h1>
      <div class="grid2"><div class="card"><div class="muted">Balance</div><b style="font-size:22px">${money(d.balance.total)}</b><div class="bal-parts"><div><div class="muted small">Transactions</div><b>${money(d.balance.splits)}</b></div><div><div class="muted small">Transfers</div><b>${money(d.balance.transfers)}</b></div><div><div class="muted small">Accrued</div><b>${money(d.balance.accrued)}</b></div></div></div>
        <div class="card"><div class="muted">Budget history</div>${d.history.map((h: any) => html`<div class="row"><span>${h.effective_month}</span><span>${h.from_cents == null ? 'start' : money(h.from_cents)} → <b>${money(h.monthly_cents)}</b></span><span class="muted">${h.reason ?? ''}${h.plan_id ? ` · plan #${h.plan_id}` : ''}</span></div>`)}</div></div>
      <h2>Rules pointing here</h2><div class="card">${d.rules.length ? d.rules.map(ruleLine) : html`<span class="muted">None.</span>`}</div>
      <h2>Recent transactions</h2><div class="card"><table><tbody>${d.transactions.map((t: any) => html`<tr><td>${fmtDate(t.occurred_on)}</td><td>${t.descriptor_clean || t.descriptor_raw}</td><td class="num ${t.amount_cents < 0 ? 'neg' : 'pos'}">${money(t.amount_cents)}</td></tr>`)}</tbody></table></div>`;
  }
}
export type { Cat };
