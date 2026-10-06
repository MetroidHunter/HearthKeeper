import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { type Cat } from '../shared.js';
import { pageHead, th, catSelect, showDialog, promptBox, confirmBox } from '../ui.js';

const PAGE = 50;
/** Rules and merchants. The household has thousands of merchants, so lists are paged and searched on the server; only 50 rows are ever in the DOM. */
@customElement('hk-rules')
export class Rules extends Page {
  @state() rules: any[] = []; @state() merch: { rows: any[]; total: number; unreviewed: number } = { rows: [], total: 0, unreviewed: 0 }; @state() promotable: any[] = []; @state() cats: Cat[] = [];
  @state() tab: 'rules' | 'merchants' = 'rules'; @state() draft: any = null; @state() bt: any = null;
  @state() rq = ''; @state() rpage = 0; @state() mq = ''; @state() mpage = 0; @state() onlyNew = false;
  private timer: any;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.rules, this.promotable, this.cats] = await Promise.all([api.get('/api/rules'), api.get('/api/rules/promotable'), api.get('/api/categories')]); await this.loadMerchants(); }); }
  async loadMerchants() { this.merch = await api.get(`/api/merchants?limit=${PAGE}&offset=${this.mpage * PAGE}${this.mq ? `&q=${encodeURIComponent(this.mq)}` : ''}${this.onlyNew ? '&review=unreviewed' : ''}`); }
  summary(r: any) { try { return JSON.parse(r.match_json).all_of.map((c: any) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' AND '); } catch { return ''; } }
  act(r: any) { const a = JSON.parse(r.action_json); return a.type === 'categorize' ? a.category : a.type; }
  async test() { const d = this.draft; await this.run(async () => { this.bt = await api.post('/api/rules/backtest', { match: this.matchOf(d) }); }); }
  matchOf(d: any) { return { all_of: [{ field: d.field, op: d.op, value: d.value }] }; }
  render() {
    return html`${pageHead('Rules & merchants', 'How transactions get categorized without you. A rule says "when the description contains X, use category Y"; a merchant remembers its usual category.', 'Rules start in suggest mode: they offer an answer but you confirm. After enough clean confirmations a rule can be promoted to auto. Backtest a new rule to see what it would have done to your history before saving it.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="tabs"><button aria-pressed=${this.tab === 'rules'} @click=${() => (this.tab = 'rules')}>Rules (${this.rules.length})</button><button aria-pressed=${this.tab === 'merchants'} @click=${() => (this.tab = 'merchants')}>Merchants (${this.merch.total.toLocaleString()}${this.merch.unreviewed ? `, ${this.merch.unreviewed.toLocaleString()} to review` : ''})</button></div>
      ${this.tab === 'rules' ? this.rulesTab() : this.merchantsTab()}`;
  }
  pager(page: number, total: number, set: (n: number) => void) {
    const last = Math.max(0, Math.ceil(total / PAGE) - 1);
    return html`<div class="pager"><button ?disabled=${page <= 0} @click=${() => set(page - 1)}>← Previous</button><span class="muted">${total === 0 ? 'No results' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total.toLocaleString()}`}</span><button ?disabled=${page >= last} @click=${() => set(page + 1)}>Next →</button></div>`;
  }
  rulesTab() {
    const q = this.rq.toLowerCase();
    const list = this.rules.filter((r) => !q || `${this.summary(r)} ${this.act(r)} ${r.notes ?? ''}`.toLowerCase().includes(q));
    const rows = list.slice(this.rpage * PAGE, (this.rpage + 1) * PAGE);
    return html`${this.promotable.length ? html`<div class="card"><h3>Ready to promote to auto</h3><div class="list">${this.promotable.map((p) => html`<div class="list-row"><span class="grow">${p.notes ?? `rule #${p.id}`} · ${p.clean_confirmations} clean confirmations, 0 overrides</span><button class="primary" @click=${async () => { await api.patch(`/api/rules/${p.id}`, { mode: 'auto' }); this.load(); }}>Promote</button></div>`)}</div></div>` : nothing}
      <div class="row"><input class="grow" type="search" placeholder="Filter rules" .value=${this.rq} @input=${(e: any) => { this.rq = e.target.value; this.rpage = 0; }} /><button class="primary" @click=${() => (this.draft = { field: 'descriptor', op: 'contains', value: '', category: 0, mode: 'suggest', priority: 100 })}>＋ New rule</button></div>
      ${this.draft ? this.draftCard() : nothing}
      <div class="card flush" style="overflow-x:auto"><table><thead><tr>${th('Pri', 'Priority: lower numbers are checked first; the most specific rule wins ties.')}${th('Match', 'The condition on the transaction.')}${th('→', 'The category it assigns.')}${th('Mode', 'auto: applies silently. suggest: offers it. ask: always asks.')}${th('Hits', 'How many transactions this rule has matched.', 'num')}${th('✓ / ✗', 'Times you accepted its answer / changed it.', 'num hide-sm')}<th></th></tr></thead><tbody>
        ${rows.map((r) => html`<tr style=${r.enabled ? '' : 'opacity:.5'}><td>${r.priority}</td><td>${this.summary(r)}<div class="muted small">${r.origin}${r.notes ? ` · ${String(r.notes).slice(0, 60)}` : ''}</div></td><td>${this.act(r)}</td>
          <td><select @change=${async (e: any) => { await api.patch(`/api/rules/${r.id}`, { mode: e.target.value }); this.load(); }}>${['auto', 'suggest', 'ask'].map((m) => html`<option ?selected=${m === r.mode}>${m}</option>`)}</select></td>
          <td class="num">${r.hit_count}</td><td class="num hide-sm">${r.clean_confirmations} / ${r.override_count}</td><td><button @click=${async () => { await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); this.load(); }}>${r.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>
      ${this.pager(this.rpage, list.length, (n) => (this.rpage = n))}`;
  }
  draftCard() {
    return html`<div class="card"><div class="row"><select @change=${(e: any) => (this.draft.field = e.target.value)}>${['descriptor', 'merchant', 'merchant_group', 'note', 'counterparty', 'item_name', 'account', 'source'].map((f) => html`<option ?selected=${f === this.draft.field}>${f}</option>`)}</select>
        <select @change=${(e: any) => (this.draft.op = e.target.value)}>${['contains', 'word', 'starts_with', 'regex', 'eq'].map((f) => html`<option ?selected=${f === this.draft.op}>${f}</option>`)}</select><input class="grow" placeholder="value" @input=${(e: any) => { this.draft.value = e.target.value; this.bt = null; this.requestUpdate(); }} />
        ${catSelect(this.cats, this.draft.category || null, (id) => { this.draft.category = id ?? 0; this.requestUpdate(); })}<select @change=${(e: any) => (this.draft.mode = e.target.value)}>${['suggest', 'auto', 'ask'].map((m) => html`<option>${m}</option>`)}</select></div>
      <div class="row"><button @click=${() => this.test()}>Backtest</button>${this.bt ? html`<span>Would have matched <b>${this.bt.matched}</b>: ${Object.entries(this.bt.byCategory).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}</span>` : nothing}
        <button class="primary right" ?disabled=${!this.draft.value || !this.draft.category} @click=${async () => { const d = this.draft; const cat = this.cats.find((c) => c.id === d.category)!; await this.run(() => api.post('/api/rules', { match: this.matchOf(d), action: { type: 'categorize', category: cat.name }, mode: d.mode, priority: d.priority })); this.draft = null; this.bt = null; this.load(); }}>Save</button><button @click=${() => (this.draft = null)}>Cancel</button></div></div>`;
  }
  merchantsTab() {
    const m = this.merch;
    return html`<div class="row"><input class="grow" type="search" placeholder="Search merchants" .value=${this.mq} @input=${(e: any) => { this.mq = e.target.value; this.mpage = 0; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(() => this.loadMerchants()), 250); }} />
        <label><input type="checkbox" .checked=${this.onlyNew} @change=${(e: any) => { this.onlyNew = e.target.checked; this.mpage = 0; this.run(() => this.loadMerchants()); }} /> Only new merchants</label></div>
      <div class="card flush" style="overflow-x:auto"><table><thead><tr>${th('Merchant', 'The cleaned-up name. Rename it to fix how it displays everywhere.')}${th('Txns', 'Transactions attributed to it.', 'num')}${th('Default category', 'Used as the suggestion for new transactions from this merchant.')}${th('Mode', 'How the default is applied: auto, suggest or ask.')}<th></th></tr></thead><tbody>
      ${m.rows.map((x) => html`<tr><td>${x.name} ${x.review_state === 'unreviewed' ? html`<span class="badge warn">new</span>` : nothing}</td><td class="num">${x.txns}</td>
        <td>${catSelect(this.cats, x.default_category_id, async (id) => { await this.run(() => api.patch(`/api/merchants/${x.id}`, { defaultCategoryId: id })); await this.loadMerchants(); }, { placeholder: '—' })}</td>
        <td>${x.default_mode}</td><td><div class="row"><button @click=${() => this.rename(x)}>Rename</button><button @click=${() => this.merge(x)}>Merge…</button></div></td></tr>`)}</tbody></table></div>
      ${this.pager(this.mpage, m.total, (n) => { this.mpage = n; this.run(() => this.loadMerchants()); })}`;
  }
  async rename(x: any) { const n = await promptBox({ title: `Rename ${x.name}`, label: 'New name', value: x.name, confirm: 'Rename' }); if (n) { await this.run(() => api.patch(`/api/merchants/${x.id}`, { name: n })); await this.loadMerchants(); } }
  async merge(x: any) {
    let q = '', found: any[] = [], timer: any; let into: any = null;
    const target = await showDialog<any>((close) => {
      const box = document.createElement('div');
      const draw = () => import('lit').then(({ render }) => render(html`${found.map((r) => html`<button class="option" @click=${() => close(r)}><span class="name">${r.name}</span><span class="meta">${r.txns} txns</span></button>`)}${q && !found.length ? html`<p class="muted">No other merchant matches.</p>` : nothing}`, box));
      box.className = 'option-list'; box.style.marginTop = '10px';
      return html`<h3 class="title">Merge “${x.name}” into…</h3><p class="muted small">Its transactions move to the merchant you choose, and its name becomes an alias of it.</p>
        <input style="width:100%" placeholder="Search for the merchant to keep" @input=${(e: any) => { q = e.target.value; clearTimeout(timer); timer = setTimeout(async () => { found = q ? (await api.get(`/api/merchants?limit=8&q=${encodeURIComponent(q)}`)).rows.filter((r: any) => r.id !== x.id) : []; draw(); }, 200); }} />${box}
        <div class="actions"><button @click=${() => close(undefined)}>Cancel</button></div>`;
    });
    if (target && await confirmBox({ title: 'Merge merchants?', body: html`Merge <b>${x.name}</b> into <b>${target.name}</b>? This cannot be undone.`, confirm: 'Merge', danger: true })) {
      await this.run(() => api.post(`/api/merchants/${x.id}/merge`, { intoId: target.id })); await this.loadMerchants();
    }
  }
}
