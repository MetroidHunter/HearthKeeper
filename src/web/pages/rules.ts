import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { type Cat } from '../shared.js';
import { pageHead, th, catSelect, showDialog, promptBox, confirmBox, toast } from '../ui.js';

const PAGE = 50;
/** Rules and merchants. The household has thousands of merchants, so lists are paged and searched on the server; only 50 rows are ever in the DOM. */
@customElement('hk-rules')
export class Rules extends Page {
  @state() rules: any[] = []; @state() merch: { rows: any[]; total: number; unreviewed: number; withoutDefault: number } = { rows: [], total: 0, unreviewed: 0, withoutDefault: 0 }; @state() promotable: any[] = []; @state() cats: Cat[] = [];
  @state() tab: 'rules' | 'merchants' = 'rules'; @state() draft: any = null; @state() bt: any = null;
  @state() rq = ''; @state() rpage = 0; @state() showOff = false; @state() mq = ''; @state() mpage = 0; @state() onlyNew = true; /* true = only shops with no usual category yet */
  private timer: any;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.rules, this.promotable, this.cats] = await Promise.all([api.get('/api/rules'), api.get('/api/rules/promotable'), api.get('/api/categories')]); await this.loadMerchants(); }); }
  async loadMerchants() { this.merch = await api.get(`/api/merchants?limit=${PAGE}&offset=${this.mpage * PAGE}${this.mq ? `&q=${encodeURIComponent(this.mq)}` : ''}${this.onlyNew ? '&review=nodefault' : ''}`); }
  summary(r: any) { try { return JSON.parse(r.match_json).all_of.map((c: any) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' AND '); } catch { return ''; } }
  act(r: any) { const a = JSON.parse(r.action_json); return a.type === 'categorize' ? a.category : a.type; }
  async test() { const d = this.draft; await this.run(async () => { this.bt = await api.post('/api/rules/backtest', { match: this.matchOf(d) }); }); }
  matchOf(d: any) { return { all_of: [{ field: d.field, op: d.op, value: d.value }] }; }
  render() {
    return html`${pageHead('Rules & merchants', 'How transactions get categorized without you. A rule says "when the description contains X, use category Y"; a merchant remembers its usual category.', 'Rules start in suggest mode: they offer an answer but you confirm. After enough clean confirmations a rule can be promoted to auto. Backtest a new rule to see what it would have done to your history before saving it.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="tabs"><button aria-pressed=${this.tab === 'rules'} @click=${() => (this.tab = 'rules')}>Rules (${this.rules.filter((r) => r.enabled).length}${this.rules.some((r) => !r.enabled) ? ` of ${this.rules.length}` : ''})</button><button aria-pressed=${this.tab === 'merchants'} @click=${() => (this.tab = 'merchants')}>Merchants</button></div>
      ${this.tab === 'rules' ? this.rulesTab() : this.merchantsTab()}`;
  }
  pager(page: number, total: number, set: (n: number) => void) {
    const last = Math.max(0, Math.ceil(total / PAGE) - 1);
    return html`<div class="pager"><button ?disabled=${page <= 0} @click=${() => set(page - 1)}>← Previous</button><span class="muted">${total === 0 ? 'No results' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total.toLocaleString()}`}</span><button ?disabled=${page >= last} @click=${() => set(page + 1)}>Next →</button></div>`;
  }
  rulesTab() {
    const q = this.rq.toLowerCase();
    const off = this.rules.filter((r) => !r.enabled).length;
    // disabled rules are hidden unless asked for, and always sort below the active ones (the API already orders by priority within each group)
    const list = this.rules.filter((r) => (this.showOff || r.enabled) && (!q || `${this.summary(r)} ${this.act(r)} ${r.notes ?? ''}`.toLowerCase().includes(q))).sort((a, b) => Number(!!b.enabled) - Number(!!a.enabled));
    const rows = list.slice(this.rpage * PAGE, (this.rpage + 1) * PAGE);
    return html`${this.promotable.length ? html`<div class="card"><h3>Ready to promote to auto</h3><div class="list">${this.promotable.map((p) => html`<div class="list-row"><span class="grow">${p.notes ?? `rule #${p.id}`} · ${p.clean_confirmations} clean confirmations, 0 overrides</span><button class="primary" @click=${async () => { await api.patch(`/api/rules/${p.id}`, { mode: 'auto' }); this.load(); }}>Promote</button></div>`)}</div></div>` : nothing}
      <div class="row"><input class="grow" type="search" placeholder="Filter rules" .value=${this.rq} @input=${(e: any) => { this.rq = e.target.value; this.rpage = 0; }} />${off ? html`<label><input type="checkbox" id="show-off" .checked=${this.showOff} @change=${(e: any) => { this.showOff = e.target.checked; this.rpage = 0; }} /> Show disabled (${off})</label>` : nothing}<button class="primary" @click=${() => (this.draft = { field: 'descriptor', op: 'contains', value: '', category: 0, mode: 'suggest', priority: 100 })}>＋ New rule</button></div>
      ${this.draft ? this.draftCard() : nothing}
      <div class="card flush" style="overflow-x:auto"><table><thead><tr>${th('Pri', 'Priority: lower numbers are checked first; the most specific rule wins ties.')}${th('Match', 'The condition on the transaction.')}${th('→', 'The category it assigns.')}${th('Mode', 'auto: applies silently. suggest: offers it. ask: always asks.')}${th('Hits', 'How many transactions this rule has matched.', 'num')}${th('✓ / ✗', 'Times you accepted its answer / changed it.', 'num hide-sm')}<th></th></tr></thead><tbody>
        ${rows.map((r) => html`<tr style=${r.enabled ? '' : 'opacity:.5'}><td>${r.priority}</td><td>${this.summary(r)}<div class="muted small">${r.origin}${r.notes ? ` · ${String(r.notes).slice(0, 60)}` : ''}</div></td><td>${this.act(r)}</td>
          <td><select @change=${async (e: any) => { await api.patch(`/api/rules/${r.id}`, { mode: e.target.value }); this.load(); }}>${['auto', 'suggest', 'ask'].map((m) => html`<option ?selected=${m === r.mode}>${m}</option>`)}</select></td>
          <td class="num">${r.hit_count}</td><td class="num hide-sm">${r.clean_confirmations} / ${r.override_count}</td><td><button class=${r.enabled ? 'rule-off' : 'rule-on'} @click=${async () => { await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); if (r.enabled && !this.showOff) toast('Rule disabled and hidden. Tick "Show disabled" to see it again.'); await this.load(); }}>${r.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>
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
    return html`<div class="card muted small" style="margin:0">A <b>merchant</b> is a shop's cleaned-up name, taken from the messy text on your bank statement ("SQ *BLUE BOTTLE #12 SEATTLE WA" becomes "BLUE BOTTLE"). Nothing here needs your attention: this is just the quickest way to teach HearthKeeper. Pick a <b>usual category</b> and future purchases there arrive pre-filled in your Backlog (<b>suggest</b>), or are filed without asking (<b>auto</b>). Rules, in the other tab, are for patterns that span several merchants.</div>
      <div class="row"><input class="grow" type="search" placeholder="Search merchants" .value=${this.mq} @input=${(e: any) => { this.mq = e.target.value; this.mpage = 0; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(() => this.loadMerchants()), 250); }} />
        <select aria-label="Which merchants" @change=${(e: any) => { this.onlyNew = e.target.value === 'nodefault'; this.mpage = 0; this.run(() => this.loadMerchants()); }}><option value="nodefault" ?selected=${this.onlyNew}>No usual category yet (${m.withoutDefault.toLocaleString()}), most-used first</option><option value="all" ?selected=${!this.onlyNew}>All merchants (most-used first)</option></select></div>
      <div class="card flush mlist"><div class="mrow mhead"><span data-tip="The cleaned-up name of the shop." tabindex="0">Merchant</span><span class="num" data-tip="How many of your transactions are from it." tabindex="0">Txns</span><span data-tip="Future purchases here are pre-filled with this category." tabindex="0">Usual category</span><span data-tip="suggest: pre-fills it in your Backlog and you confirm. auto: files it without asking. ask: no pre-fill." tabindex="0">When it buys</span><span></span></div>
      ${repeat(m.rows, (x: any) => x.id, (x: any) => html`<div class="mrow"><div class="mname"><b>${x.name}</b><span class="muted small mtx">${x.txns} txn${x.txns === 1 ? '' : 's'}</span></div><span class="num mtxn">${x.txns}</span>
        <div class="mcat">${catSelect(this.cats, x.default_category_id, (id) => this.setDefault(x, id), { placeholder: 'Pick a category' })}</div>
        <div class="mact"><select aria-label="Mode" ?disabled=${!x.default_category_id} @change=${(e: any) => this.setMode(x, e.target.value)}>${['suggest', 'auto', 'ask'].map((o) => html`<option ?selected=${o === x.default_mode}>${o}</option>`)}</select><button @click=${() => this.fix(x)}>Fix name…</button></div></div>`)}</div>
      ${this.pager(this.mpage, m.total, (n) => { this.mpage = n; this.run(() => this.loadMerchants()); })}`;
  }
  /** Saved in place: the row stays where it is (it only leaves the "no usual category" list when you reload or change page), with a confirmation. */
  async setDefault(x: any, id: number | null) {
    await this.run(() => api.patch(`/api/merchants/${x.id}`, { defaultCategoryId: id }));
    const had = !!x.default_category_id; x.default_category_id = id;
    const name = id ? this.cats.find((c) => c.id === id)?.name : null;
    if (!had && id) this.merch = { ...this.merch, withoutDefault: Math.max(0, this.merch.withoutDefault - 1) };
    if (had && !id) this.merch = { ...this.merch, withoutDefault: this.merch.withoutDefault + 1 };
    this.requestUpdate();
    toast(id ? `${x.name} → ${name} (${x.default_mode}). Future purchases there will be ${x.default_mode === 'auto' ? 'filed automatically' : x.default_mode === 'ask' ? 'left for you' : 'pre-filled for you to confirm'}.` : `${x.name}: usual category removed`);
  }
  async setMode(x: any, mode: string) { await this.run(() => api.patch(`/api/merchants/${x.id}`, { defaultMode: mode })); x.default_mode = mode; this.requestUpdate(); toast(`${x.name}: ${mode}`); }
  /** One entry point for the two maintenance actions, each explained. */
  async fix(x: any) {
    const choice = await showDialog<'rename' | 'merge' | undefined>((close) => html`<h3 class="title">${x.name}</h3>
      <p class="muted small"><b>Rename</b> changes how the name is shown everywhere. Use it when the cleaned-up name is ugly or wrong.</p>
      <p class="muted small"><b>Merge</b> is for when two entries are really the same shop (for example "AMZN MKTP" and "AMAZON"). All of its transactions move to the one you keep, so they share a usual category and statistics. You cannot undo it.</p>
      <div class="actions"><button @click=${() => close(undefined)}>Cancel</button><button @click=${() => close('rename')}>Rename…</button><button @click=${() => close('merge')}>Merge into another…</button></div>`);
    if (choice === 'rename') await this.rename(x); else if (choice === 'merge') await this.merge(x);
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
