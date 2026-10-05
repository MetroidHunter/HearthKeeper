import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { catOptions, amt, type Cat } from '../shared.js';

@customElement('hk-transactions')
export class Transactions extends Page {
  @state() rows: any[] = []; @state() cats: Cat[] = []; @state() q = ''; @state() category = ''; @state() hidden = false; @state() open: any = null; @state() rows_: { categoryId: number | null; cents: number }[] = []; @state() sel = new Set<number>();
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.cats = await api.get('/api/categories'); this.rows = await api.get(`/api/transactions?limit=200&hidden=${this.hidden ? 1 : 0}${this.q ? `&q=${encodeURIComponent(this.q)}` : ''}${this.category ? `&category=${this.category}` : ''}`); }); }
  async bulk(categoryId: number) { await this.run(async () => { for (const id of this.sel) await api.post(`/api/transactions/${id}/categorize`, { categoryId }); }); this.sel = new Set(); this.load(); }
  render() {
    return html`<h1>Transactions</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><input class="grow" type="search" placeholder="Search" .value=${this.q} @change=${(e: any) => { this.q = e.target.value; this.load(); }} />
        <select @change=${(e: any) => { this.category = e.target.value; this.load(); }}>${catOptions(this.cats, null, { blank: 'All categories', includeRetired: true })}</select>
        <label><input type="checkbox" .checked=${this.hidden} @change=${(e: any) => { this.hidden = e.target.checked; this.load(); }} /> Show hidden</label></div>
      ${this.sel.size ? html`<div class="card row"><b>${this.sel.size} selected</b><select @change=${(e: any) => e.target.value && this.bulk(Number(e.target.value))}>${catOptions(this.cats, null, { blank: 'Set category…' })}</select></div>` : ''}
      <div class="card" style="overflow-x:auto"><table><thead><tr><th></th><th>Date</th><th>Description</th><th class="hide-sm">Account</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>
        ${this.rows.map((t) => html`<tr style="cursor:pointer" @click=${() => this.openTxn(t)}>
          <td @click=${(e: Event) => e.stopPropagation()}><input type="checkbox" .checked=${this.sel.has(t.id)} @change=${(e: any) => { e.target.checked ? this.sel.add(t.id) : this.sel.delete(t.id); this.requestUpdate(); }} /></td>
          <td>${fmtDate(t.occurred_on)}</td><td>${t.descriptor_clean || t.descriptor_raw} ${t.status === 'provisional' ? html`<span class="badge warn">pending</span>` : ''}${t.kind === 'ignored' || t.kind === 'internal_transfer' ? html`<span class="badge">${t.ignored_reason ?? t.kind}</span>` : ''}${t.flagged ? html`<span class="badge bad">flag</span>` : ''}</td>
          <td class="hide-sm muted">${t.account}</td><td>${t.splits.length > 1 ? `${t.splits.length} splits` : t.splits[0]?.category ?? html`<span class="badge warn">needs category</span>`}</td><td class="num">${amt(t.amount_cents)}</td></tr>`)}
      </tbody></table></div>${this.open ? this.detail() : ''}`;
  }
  /** Draft splits live in component state so re-renders (adding a row, typing an amount) never discard edits. */
  openTxn(t: any) {
    this.err = '';
    this.rows_ = t.splits.length ? t.splits.map((s: any) => ({ categoryId: s.category_id, cents: s.amount_cents })) : [{ categoryId: null, cents: t.amount_cents }];
    this.open = t;
  }
  detail() {
    const t = this.open; const rows = this.rows_;
    const sum = () => rows.reduce((a: number, r: any) => a + r.cents, 0);
    return html`<dialog open><h2 style="margin-top:0">${t.descriptor_raw}</h2><div class="muted">${t.occurred_on} · ${t.account} · ${money(t.amount_cents)} ${t.decided_by ? `· decided by ${t.decided_by}${t.decided_rule_id ? ` (rule #${t.decided_rule_id})` : ''}` : ''}</div>
      ${t.kind === 'ignored' || t.kind === 'internal_transfer' ? html`<p>Hidden: ${t.ignored_reason}. <button @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/restore`)); this.open = null; this.load(); }}>Restore</button></p>` : html`
      <h2>Splits</h2>${rows.map((r: any, i: number) => html`<div class="row" style="margin-bottom:6px"><select class="grow" @change=${(e: any) => (r.categoryId = Number(e.target.value))}>${catOptions(this.cats, r.categoryId, { blank: 'Category', includeRetired: true })}</select>
        <input style="width:7rem" .value=${(r.cents / 100).toFixed(2)} @change=${(e: any) => { r.cents = parseMoney(e.target.value); this.requestUpdate(); }} />${rows.length > 1 ? html`<button @click=${() => { rows.splice(i, 1); this.requestUpdate(); }}>✕</button>` : ''}</div>`)}
      <div class="row"><button @click=${() => { rows.push({ categoryId: null, cents: 0 }); this.requestUpdate(); }}>＋ split</button>
        <button @click=${() => { if (rows.length === 2) { rows[0].cents = Math.round(t.amount_cents * 0.5); rows[1].cents = t.amount_cents - rows[0].cents; this.requestUpdate(); } }}>Even (2-way)</button>
        <span class="muted right">remaining ${money(t.amount_cents - sum())}</span></div>
      <h2>Note</h2><input style="width:100%" .value=${t.note ?? ''} @change=${async (e: any) => { await this.run(() => api.patch(`/api/transactions/${t.id}`, { note: e.target.value })); }} />`}
      <div class="row" style="margin-top:12px"><button @click=${() => (this.open = null)}>Close</button>
        ${t.kind === 'ignored' || t.kind === 'internal_transfer' ? '' : html`<button class="danger" @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'user' })); this.open = null; this.load(); }}>Hide</button>
        <button class="primary" @click=${async () => { if (sum() !== t.amount_cents) { this.err = 'Splits must equal the amount'; this.requestUpdate(); return; } await this.run(() => api.post(`/api/transactions/${t.id}/categorize`, { splits: rows.map((r: any) => ({ categoryId: r.categoryId, amountCents: r.cents })) })); this.open = null; this.load(); }}>Save</button>`}</div>
      ${this.err ? html`<p class="err">${this.err}</p>` : ''}</dialog>`;
  }
}
