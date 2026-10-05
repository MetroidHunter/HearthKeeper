import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { catOptions, amt, type Cat } from '../shared.js';

@customElement('hk-transactions')
export class Transactions extends Page {
  @state() rows: any[] = []; @state() cats: Cat[] = []; @state() q = ''; @state() category = ''; @state() hidden = false; @state() open: any = null; @state() rows_: { categoryId: number | null; cents: number }[] = []; @state() cands: any[] = []; @state() items: any = null; @state() hist: any[] = []; @state() sel = new Set<number>();
  @state() from = ''; @state() to = '';
  connectedCallback() {
    super.connectedCallback();
    const qs = new URLSearchParams(location.hash.split('?')[1] ?? ''); // drill-down from a chart: #/transactions?category=3&from=2026-07-01&to=2026-07-31
    this.category = qs.get('category') ?? ''; this.from = qs.get('from') ?? ''; this.to = qs.get('to') ?? ''; this.q = qs.get('q') ?? '';
    this.load();
  }
  async load() { await this.run(async () => { this.cats = await api.get('/api/categories'); this.rows = await api.get(`/api/transactions?limit=200&hidden=${this.hidden ? 1 : 0}${this.q ? `&q=${encodeURIComponent(this.q)}` : ''}${this.category ? `&category=${this.category}` : ''}${this.from ? `&from=${this.from}` : ''}${this.to ? `&to=${this.to}` : ''}`); }); }
  async bulk(categoryId: number) { await this.run(async () => { for (const id of this.sel) await api.post(`/api/transactions/${id}/categorize`, { categoryId }); }); this.sel = new Set(); this.load(); }
  render() {
    return html`<h1>Transactions</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      ${this.from || this.to ? html`<div class="card row"><span>Showing ${this.from} → ${this.to}${this.category ? ' for one category' : ''}</span><button @click=${() => { this.from = ''; this.to = ''; this.load(); }}>Clear dates</button></div>` : ''}
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
    this.open = t; this.cands = []; this.items = null; this.hist = [];
    if (['needs_note', 'ambiguous', 'awaiting_note'].includes(t.note_state)) api.get(`/api/transactions/${t.id}/note-candidates`).then((c) => { this.cands = c; });
    api.get(`/api/transactions/${t.id}/history`).then((h) => { this.hist = h; });
  }
  async loadItems(t: any) { await this.run(async () => { this.items = await api.get(`/api/transactions/${t.id}/item-splits`); if (this.items?.status === 'proposed') this.rows_ = this.items.items.map((i: any) => ({ categoryId: i.categoryId, cents: i.cents })); }); }
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
      ${this.cands.length ? html`<h2>Which note is this?</h2>${this.cands.slice(0, 5).map((c) => html`<div class="row" style="margin-bottom:4px"><span class="badge">${c.source}</span><span class="grow">${c.note || '(no note)'} <span class="muted">${c.counterparty ?? ''} · ${c.occurred_on}</span></span><button class="pick-note" @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/note`, { noteId: c.id })); this.cands = []; this.load(); }}>Use this</button></div>`)}` : ''}
      <div class="row" style="margin-top:6px"><button id="assign-items" @click=${() => this.loadItems(t)}>Assign items…</button></div>
      ${this.items ? (this.items.status === 'proposed' ? html`<p class="muted">Items allocated with tax and shipping so the splits add up to the charge. Review, then Save.</p>${this.items.items.map((i: any) => html`<div class="muted">${i.name} ${i.suggestedBy ? `· ${i.suggestedBy}` : ''}</div>`)}` : html`<p class="muted">This charge covers only part of the order (${this.items.status === 'pick_subset' ? 'several item combinations match' : 'no combination matches'}); split by hand.</p>`) : ''}
      <h2>Note</h2><input style="width:100%" .value=${t.note ?? ''} @change=${async (e: any) => { await this.run(() => api.patch(`/api/transactions/${t.id}`, { note: e.target.value })); }} />`}
      <div class="row" style="margin-top:12px"><button @click=${() => (this.open = null)}>Close</button>
        ${t.kind === 'ignored' || t.kind === 'internal_transfer' ? '' : html`<button class="danger" @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'user' })); this.open = null; this.load(); }}>Hide</button>
        <button class="primary" @click=${async () => { if (sum() !== t.amount_cents) { this.err = 'Splits must equal the amount'; this.requestUpdate(); return; } await this.run(() => api.post(`/api/transactions/${t.id}/categorize`, { splits: rows.map((r: any) => ({ categoryId: r.categoryId, amountCents: r.cents })) })); this.open = null; this.load(); }}>Save</button>`}</div>
      ${this.hist.length ? html`<details style="margin-top:10px"><summary class="muted">History (${this.hist.length})</summary>${this.hist.map((h: any) => html`<div class="muted" style="font-size:12px">${h.at} · ${h.actor} · ${h.action}</div>`)}</details>` : ''}
      ${this.err ? html`<p class="err">${this.err}</p>` : ''}</dialog>`;
  }
}
