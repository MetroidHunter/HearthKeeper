import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { catOptions, type Cat } from '../shared.js';

@customElement('hk-rules')
export class Rules extends Page {
  @state() rules: any[] = []; @state() merchants: any[] = []; @state() promotable: any[] = []; @state() cats: Cat[] = []; @state() tab: 'rules' | 'merchants' = 'rules'; @state() draft: any = null; @state() bt: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.rules, this.merchants, this.promotable, this.cats] = await Promise.all([api.get('/api/rules'), api.get('/api/merchants'), api.get('/api/rules/promotable'), api.get('/api/categories')]); }); }
  summary(r: any) { try { return JSON.parse(r.match_json).all_of.map((c: any) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(' AND '); } catch { return ''; } }
  act(r: any) { const a = JSON.parse(r.action_json); return a.type === 'categorize' ? a.category : a.type; }
  async test() { const d = this.draft; await this.run(async () => { this.bt = await api.post('/api/rules/backtest', { match: this.matchOf(d) }); }); }
  matchOf(d: any) { const all_of: any[] = [{ field: d.field, op: d.op, value: d.value }]; return { all_of }; }
  render() {
    return html`<h1>Rules &amp; merchants</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="tabs"><button class=${this.tab === 'rules' ? 'primary' : ''} @click=${() => (this.tab = 'rules')}>Rules (${this.rules.length})</button><button class=${this.tab === 'merchants' ? 'primary' : ''} @click=${() => (this.tab = 'merchants')}>Merchants to review (${this.merchants.filter((m) => m.review_state === 'unreviewed').length})</button></div>
      ${this.tab === 'rules' ? this.rulesTab() : this.merchantsTab()}`;
  }
  rulesTab() {
    return html`${this.promotable.length ? html`<div class="card"><b>Ready to promote to auto</b>${this.promotable.map((p) => html`<div class="row"><span class="grow">${p.notes ?? `rule #${p.id}`} · ${p.clean_confirmations} clean confirmations, 0 overrides</span><button class="primary" @click=${async () => { await api.patch(`/api/rules/${p.id}`, { mode: 'auto' }); this.load(); }}>Promote</button></div>`)}</div>` : ''}
      <div class="row" style="margin-bottom:8px"><button class="primary" @click=${() => (this.draft = { field: 'descriptor', op: 'contains', value: '', category: 0, mode: 'suggest', priority: 100 })}>＋ New rule</button></div>
      ${this.draft ? html`<div class="card"><div class="row"><select @change=${(e: any) => (this.draft.field = e.target.value)}>${['descriptor', 'merchant', 'merchant_group', 'note', 'counterparty', 'item_name', 'account', 'source'].map((f) => html`<option ?selected=${f === this.draft.field}>${f}</option>`)}</select>
        <select @change=${(e: any) => (this.draft.op = e.target.value)}>${['contains', 'word', 'starts_with', 'regex', 'eq'].map((f) => html`<option ?selected=${f === this.draft.op}>${f}</option>`)}</select><input class="grow" placeholder="value" @input=${(e: any) => { this.draft.value = e.target.value; this.bt = null; this.requestUpdate(); }} />
        <select @change=${(e: any) => { this.draft.category = Number(e.target.value); this.requestUpdate(); }}>${catOptions(this.cats, null, { blank: 'Category' })}</select><select @change=${(e: any) => (this.draft.mode = e.target.value)}>${['suggest', 'auto', 'ask'].map((m) => html`<option>${m}</option>`)}</select></div>
        <div class="row" style="margin-top:8px"><button @click=${() => this.test()}>Backtest</button>${this.bt ? html`<span>Would have matched <b>${this.bt.matched}</b>: ${Object.entries(this.bt.byCategory).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}</span>` : ''}
          <button class="primary right" ?disabled=${!this.draft.value || !this.draft.category} @click=${async () => { const d = this.draft; const cat = this.cats.find((c) => c.id === d.category)!; await this.run(() => api.post('/api/rules', { match: this.matchOf(d), action: { type: 'categorize', category: cat.name }, mode: d.mode, priority: d.priority })); this.draft = null; this.bt = null; this.load(); }}>Save</button><button @click=${() => (this.draft = null)}>Cancel</button></div></div>` : ''}
      <div class="card" style="overflow-x:auto"><table><thead><tr><th>Pri</th><th>Match</th><th>→</th><th>Mode</th><th class="num">Hits</th><th class="num hide-sm">✓ / ✗</th><th></th></tr></thead><tbody>
        ${this.rules.map((r) => html`<tr style=${r.enabled ? '' : 'opacity:.5'}><td>${r.priority}</td><td>${this.summary(r)}<div class="muted">${r.origin}${r.notes ? ` · ${String(r.notes).slice(0, 60)}` : ''}</div></td><td>${this.act(r)}</td>
          <td><select @change=${async (e: any) => { await api.patch(`/api/rules/${r.id}`, { mode: e.target.value }); this.load(); }}>${['auto', 'suggest', 'ask'].map((m) => html`<option ?selected=${m === r.mode}>${m}</option>`)}</select></td>
          <td class="num">${r.hit_count}</td><td class="num hide-sm">${r.clean_confirmations} / ${r.override_count}</td><td><button @click=${async () => { await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); this.load(); }}>${r.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>`;
  }
  merchantsTab() {
    return html`<div class="card" style="overflow-x:auto"><table><thead><tr><th>Merchant</th><th class="num">Txns</th><th>Default category</th><th>Mode</th><th></th></tr></thead><tbody>
      ${this.merchants.map((m) => html`<tr><td>${m.name} ${m.review_state === 'unreviewed' ? html`<span class="badge warn">new</span>` : ''}</td><td class="num">${m.txns}</td>
        <td><select @change=${async (e: any) => { await api.patch(`/api/merchants/${m.id}`, { defaultCategoryId: Number(e.target.value) || null }); this.load(); }}>${catOptions(this.cats, m.default_category_id, { blank: '—' })}</select></td>
        <td>${m.default_mode}</td><td><button @click=${async () => { const n = prompt('Rename to', m.name); if (n) { await api.patch(`/api/merchants/${m.id}`, { name: n }); this.load(); } }}>Rename</button>
          <select @change=${async (e: any) => { const to = Number(e.target.value); if (to && confirm(`Merge "${m.name}" into the selected merchant?`)) { await api.post(`/api/merchants/${m.id}/merge`, { intoId: to }); this.load(); } }}><option value="">Merge into…</option>${this.merchants.filter((x) => x.id !== m.id).map((x) => html`<option value=${x.id}>${x.name}</option>`)}</select></td></tr>`)}</tbody></table></div>`;
  }
}
