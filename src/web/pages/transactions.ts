import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney, fmtDate } from '../api.js';
import { amt, type Cat } from '../shared.js';
import { pageHead, th, catSelect, clickedBackdrop, pendingBadge } from '../ui.js';

@customElement('hk-transactions')
export class Transactions extends Page {
  @state() rows: any[] = []; @state() cats: Cat[] = []; @state() q = ''; @state() category = ''; @state() hidden = false; @state() open: any = null; @state() rows_: { categoryId: number | null; cents: number }[] = []; @state() cands: any[] = []; @state() items: any = null; @state() hist: any[] = []; @state() sel = new Set<number>();
  @state() from = ''; @state() to = ''; @state() page = 0; @state() size = 50; @state() total = 0;
  connectedCallback() {
    super.connectedCallback();
    const qs = new URLSearchParams(location.hash.split('?')[1] ?? ''); // drill-down from a chart: #/transactions?category=3&from=2026-07-01&to=2026-07-31
    this.category = qs.get('category') ?? ''; this.from = qs.get('from') ?? ''; this.to = qs.get('to') ?? ''; this.q = qs.get('q') ?? '';
    this.load();
  }
  private qs() { return `hidden=${this.hidden ? 1 : 0}${this.q ? `&q=${encodeURIComponent(this.q)}` : ''}${this.category ? `&category=${this.category}` : ''}${this.from ? `&from=${this.from}` : ''}${this.to ? `&to=${this.to}` : ''}`; }
  /** `resetPage` is true whenever a filter changed; paging itself keeps the page. */
  async load(resetPage = false) {
    if (resetPage) this.page = 0;
    await this.run(async () => {
      this.cats = await api.get('/api/categories');
      const [rows, count] = await Promise.all([api.get(`/api/transactions?limit=${this.size}&offset=${this.page * this.size}&${this.qs()}`), api.get(`/api/transactions/count?${this.qs()}`)]);
      this.rows = rows; this.total = count.total;
      const last = Math.max(0, Math.ceil(this.total / this.size) - 1);
      if (this.page > last) { this.page = last; this.rows = await api.get(`/api/transactions?limit=${this.size}&offset=${this.page * this.size}&${this.qs()}`); }
    });
  }
  pager() {
    const pages = Math.max(1, Math.ceil(this.total / this.size)); const from = this.total ? this.page * this.size + 1 : 0, to = Math.min(this.total, (this.page + 1) * this.size);
    const go = (n: number) => { this.page = Math.min(pages - 1, Math.max(0, n)); this.load(); window.scrollTo({ top: 0 }); };
    return html`<div class="pager"><button class="first" ?disabled=${this.page === 0} @click=${() => go(0)}>« First</button><button class="prev" ?disabled=${this.page === 0} @click=${() => go(this.page - 1)}>‹ Previous</button>
      <span class="muted">${from.toLocaleString()}–${to.toLocaleString()} of ${this.total.toLocaleString()} · page <input class="jump" type="number" min="1" max=${pages} style="width:4.5rem" .value=${String(this.page + 1)} @change=${(e: any) => go(Number(e.target.value) - 1)} /> of ${pages.toLocaleString()}</span>
      <button class="next" ?disabled=${this.page >= pages - 1} @click=${() => go(this.page + 1)}>Next ›</button><button class="last" ?disabled=${this.page >= pages - 1} @click=${() => go(pages - 1)}>Last »</button>
      <label class="right muted small">Rows per page <select class="size" @change=${(e: any) => { this.size = Number(e.target.value); this.load(true); }}>${[25, 50, 100, 200].map((n) => html`<option ?selected=${n === this.size}>${n}</option>`)}</select></label></div>`;
  }
  async bulk(categoryId: number) { await this.run(async () => { for (const id of this.sel) await api.post(`/api/transactions/${id}/categorize`, { categoryId }); }); this.sel = new Set(); this.load(); }
  render() {
    return html`${pageHead('Transactions', 'Every transaction, newest first. Search by description or note, filter by category or dates, and click any row to split it, add a note, hide it or see its history.', 'Select several rows with the checkboxes to give them all one category at once. Hidden transactions (transfers between your own accounts, things you marked "not a budget item") are kept and can be restored.')}${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      ${this.from || this.to ? html`<div class="card row"><span>Showing ${this.from} → ${this.to}${this.category ? ' for one category' : ''}</span><button @click=${() => { this.from = ''; this.to = ''; this.load(true); }}>Clear dates</button></div>` : nothing}
      <div class="row"><input class="grow" type="search" placeholder="Search description or note" .value=${this.q} @change=${(e: any) => { this.q = e.target.value; this.load(true); }} />
        ${catSelect(this.cats, this.category ? Number(this.category) : null, (id) => { this.category = id ? String(id) : ''; this.load(true); }, { placeholder: 'All categories', includeRetired: true })}
        ${this.category ? html`<button @click=${() => { this.category = ''; this.load(true); }}>Clear category</button>` : nothing}
        <label><input type="checkbox" .checked=${this.hidden} @change=${(e: any) => { this.hidden = e.target.checked; this.load(true); }} /> Show hidden</label></div>
      ${this.sel.size ? html`<div class="card row"><b>${this.sel.size} selected</b>${catSelect(this.cats, null, (id) => { if (id) void this.bulk(id); }, { placeholder: 'Set category for all…' })}<button @click=${() => { this.sel = new Set(); }}>Clear selection</button></div>` : nothing}
      ${this.pager()}
      <div class="card flush" style="overflow-x:auto"><table><thead><tr><th></th>${th('Date', 'The day it happened, in Pacific time.')}${th('Description', 'As the bank sent it. Badges: pending (not posted yet), hidden reason, flag (needs follow-up).')}${th('Note', 'What it was for: from an Amazon, Venmo or PayPal match, or typed by you. The account is in the details when you open a row.')}${th('Category', 'Where the money was counted. "Splits" means it is divided between categories.')}${th('Amount', 'Negative is money out.', 'num')}</tr></thead><tbody>
        ${this.rows.map((t) => html`<tr class="clickable" @click=${() => this.openTxn(t)}>
          <td @click=${(e: Event) => e.stopPropagation()}><input type="checkbox" .checked=${this.sel.has(t.id)} @change=${(e: any) => { e.target.checked ? this.sel.add(t.id) : this.sel.delete(t.id); this.requestUpdate(); }} /></td>
          <td>${fmtDate(t.occurred_on)}</td><td>${t.descriptor_clean || t.descriptor_raw} ${t.status === 'provisional' ? pendingBadge() : ''}${t.kind === 'ignored' || t.kind === 'internal_transfer' ? html`<span class="badge">${t.ignored_reason ?? t.kind}</span>` : ''}${t.flagged ? html`<span class="badge bad">flag</span>` : ''}</td>
          <td class="muted" style="max-width:260px">${t.note ?? ''}</td><td>${t.splits.length > 1 ? `${t.splits.length} splits` : t.splits[0]?.category ?? html`<span class="badge warn">needs category</span>`}</td><td class="num">${amt(t.amount_cents)}</td></tr>`)}
        ${this.rows.length === 0 ? html`<tr><td colspan="6" class="muted">No transactions match.</td></tr>` : nothing}
      </tbody></table></div>
      ${this.pager()}${this.open ? this.detail() : nothing}`;
  }
  updated() { const d = this.querySelector('dialog.txn-detail') as HTMLDialogElement | null; if (d && !d.open) d.showModal(); }
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
    return html`<dialog class="txn-detail" @close=${() => { if (this.open) this.open = null; }} @click=${(e: MouseEvent) => { if (clickedBackdrop(e.currentTarget as HTMLDialogElement, e)) this.open = null; }}><h2>${t.descriptor_raw}</h2><div class="muted">${t.occurred_on} · ${t.account} · ${money(t.amount_cents)} ${t.decided_by ? `· decided by ${t.decided_by}${t.decided_rule_id ? ` (rule #${t.decided_rule_id})` : ''}` : ''}</div>
      ${t.kind === 'ignored' || t.kind === 'internal_transfer' ? html`<p>Hidden: ${t.ignored_reason}. <button @click=${async () => { await this.run(() => api.post(`/api/transactions/${t.id}/restore`)); this.open = null; this.load(); }}>Restore</button></p>` : html`
      <h2>Splits</h2>${rows.map((r: any, i: number) => html`<div class="row" style="margin-bottom:6px"><span class="grow">${catSelect(this.cats, r.categoryId, (id) => (r.categoryId = id), { includeRetired: true })}</span>
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
