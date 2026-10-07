import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { amt, type Cat } from '../shared.js';
import { pageHead, catSelect, alertBox, withBusy, pagerBar } from '../ui.js';
import { txnRow, txnHead, confirmCategorize, type Env } from '../txn.js';

type View = 'merchants' | 'flagged' | 'notes';
const SIZES: Record<View, number[]> = { merchants: [5, 10, 25, 50], flagged: [25, 50, 100], notes: [25, 50, 100] };

/**
 * Backlog (design §8.3): the same decisions as Home, in bulk, one page at a time. After a big import there can be hundreds waiting, so the server
 * returns only the page being shown (a few merchants with their rows, or a page of flagged / waiting-on-note transactions) and every change
 * refreshes just that page behind a "working" modal that blocks input until it is done.
 */
@customElement('hk-backlog')
export class Backlog extends Page {
  @state() cats: Cat[] = []; @state() rows: any[] = []; @state() data: any = null; @state() loading = true;
  @state() view: View = 'merchants'; @state() page = 0; @state() size = 10; @state() q = ''; @state() last = ''; @state() open = new Set<string>();
  /** The merchant cards on screen, in order. Sent back with every refresh so a card stays put (and keeps its kind) while you answer its rows one by one. */
  private pinned: string[] = []; private kind = new Map<string, 'many' | 'one'>();
  private timer: any; private seq = 0;
  connectedCallback() { super.connectedCallback(); void this.refresh(true); }
  /** Fetch the current page (and the budget numbers the confirm dialog shows). Stale answers from an older request are ignored. */
  async refresh(first = false) {
    const mine = ++this.seq; this.loading = true;
    await this.run(async () => {
      const qs = `view=${this.view}&limit=${this.size}&offset=${this.page * this.size}${this.q ? `&q=${encodeURIComponent(this.q)}` : ''}${this.view === 'merchants' && this.pinned.length ? `&keys=${encodeURIComponent(this.pinned.join(','))}` : ''}`;
      const [d, cats, b] = await Promise.all([api.get(`/api/backlog?${qs}`), first || !this.cats.length ? api.get('/api/categories') : this.cats, api.get('/api/budget')]);
      if (mine !== this.seq) return;
      const last = Math.max(0, Math.ceil(d.total / this.size) - 1);
      if (this.page > last) { this.page = last; this.pinned = []; this.loading = false; return this.refresh(); } // the page emptied out (everything on it was answered): step back
      for (const g of d.groups as any[]) if (!this.kind.has(g.key)) this.kind.set(g.key, g.count > 1 ? 'many' : 'one');
      this.pinned = (d.groups as any[]).map((g) => g.key);
      this.data = d; this.cats = cats; this.rows = b.rows;
    });
    if (mine === this.seq) this.loading = false;
  }
  private env(): Env {
    return { cats: this.cats, rows: this.rows,
      categorize: async (ids, categoryId, rule, flag) => { for (const id of ids) await api.post(`/api/transactions/${id}/categorize`, { categoryId, rule, flag }); },
      ignore: async (t) => { await api.post(`/api/transactions/${t.id}/ignore`, { reason: 'not a budget item' }); } };
  }
  async answer(g: any, categoryId: number) {
    const first = g.items[0];
    const { ok, rule, flag } = await confirmCategorize(this.env(), [{ id: g.txnIds[0], occurred_on: first?.occurred_on ?? '', amount_cents: g.totalCents, descriptor_raw: g.name, account: '' }], categoryId, { groupName: g.name, count: g.count, seed: { merchant: g.merchantId ? g.name : null, descriptor: first?.descriptor_clean || g.name } });
    if (!ok) return;
    try {
      await withBusy(`Categorizing ${g.count} transaction${g.count === 1 ? '' : 's'} from ${g.name}…`, async () => {
        const r = await api.post('/api/inbox/bulk', { txnIds: g.txnIds, categoryId, rule, flag });
        this.last = `${g.name}: ${r.applied} categorized${r.skipped ? `, ${r.skipped} skipped (already answered)` : ''}${flag ? `; flagged for review` : ''}${r.rule ? `; rule saved (it would have matched ${r.rule.backtest.matched} past transactions)` : ''}`;
        await this.refresh();
      });
    } catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); await this.refresh(); }
  }
  /** Moving to another page, size, search or tab starts a fresh arrangement. */
  private fresh() { this.pinned = []; this.kind.clear(); }
  private go(view: View) { this.fresh(); this.view = view; this.page = 0; this.size = SIZES[view][view === 'merchants' ? 1 : 0]; this.q = ''; this.data = null; void this.refresh(); }
  render() {
    const c = this.data?.counts;
    const tab = (v: View, label: string) => html`<button aria-pressed=${this.view === v} @click=${() => this.go(v)}>${label}</button>`;
    return html`${pageHead('Backlog', 'Everything waiting on a decision, in bulk. Uncategorized transactions are grouped by merchant so one answer settles every transaction from it.', 'Flagged items (your "???" notes and other follow-ups) and items waiting on an Amazon, Venmo or PayPal note are listed one by one in their own tabs. Long lists are paged.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="tabs">${tab('merchants', `Needs a category${c ? ` (${c.needsCategory.toLocaleString()})` : ''}`)}${tab('flagged', `Flagged${c ? ` (${c.flagged.toLocaleString()})` : ''}`)}${tab('notes', `Waiting on notes${c ? ` (${c.needsNote.toLocaleString()})` : ''}`)}</div>
      ${this.last ? html`<p class="muted" role="status">${this.last}</p>` : nothing}
      ${!this.data ? html`<div class="card loadingcard" role="status"><span class="spinner" aria-hidden="true"></span><span>Loading the backlog…</span></div>` : html`
        <div class="row"><input class="grow" type="search" placeholder=${this.view === 'merchants' ? 'Filter merchants' : 'Search description or note'} .value=${this.q} @input=${(e: any) => { this.q = e.target.value; this.page = 0; this.fresh(); clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh(), 250); }} />
          <span class="muted small" aria-live="polite">${this.loading ? 'Loading…' : this.view === 'merchants' ? `${this.data.totalTxns.toLocaleString()} transactions in ${this.data.total.toLocaleString()} merchants` : `${this.data.total.toLocaleString()} transactions`}</span></div>
        ${pagerBar({ page: this.page, total: this.data.total, size: this.size, sizes: SIZES[this.view], onPage: (n) => { this.fresh(); this.page = n; this.open = new Set(); void this.refresh(); window.scrollTo({ top: 0 }); }, onSize: (n) => { this.fresh(); this.size = n; this.page = 0; void this.refresh(); } })}
        <div class=${this.loading ? 'listbusy' : ''} aria-busy=${this.loading ? 'true' : 'false'}>${this.view === 'merchants' ? this.merchants() : this.items(this.view === 'flagged' ? 'Nothing is flagged.' : 'No notes are being waited on.')}</div>
        ${this.data.total > this.size ? pagerBar({ page: this.page, total: this.data.total, size: this.size, sizes: SIZES[this.view], onPage: (n) => { this.fresh(); this.page = n; this.open = new Set(); void this.refresh(); window.scrollTo({ top: 0 }); }, onSize: (n) => { this.fresh(); this.size = n; this.page = 0; void this.refresh(); } }) : nothing}`}`;
  }
  items(empty: string) {
    const env = this.env(); const list: any[] = this.data.items;
    return list.length === 0 ? html`<div class="card muted">${this.q ? 'Nothing matches.' : empty}</div>` : html`<div class="card flush txnlist">${txnHead()}${list.map((t) => txnRow(env, t, { reload: () => this.refresh() }))}</div>`;
  }
  merchants() {
    const env = this.env(); const gs: any[] = this.data.groups;
    const rowFor = (t: any) => txnRow(env, t, { reload: () => this.refresh() });
    const isMany = (g: any) => (this.kind.get(g.key) ?? (g.count > 1 ? 'many' : 'one')) === 'many';
    const many = gs.filter(isMany), ones = gs.filter((g) => !isMany(g));
    return html`${gs.length === 0 ? html`<div class="card muted">${this.q ? 'No merchant matches.' : 'Nothing waiting.'}</div>` : nothing}
      ${many.map((g) => this.group(g, rowFor))}
      ${ones.length ? html`<div class="card flush txnlist" data-ones><div class="listtitle"><b>One transaction each</b><span class="muted small">${ones.length} merchant${ones.length === 1 ? '' : 's'}</span></div>${txnHead()}${ones.map((g) => g.items[0] ? rowFor(g.items[0]) : nothing)}</div>` : nothing}`;
  }
  /** One merchant with several transactions: a bulk bar (one answer for all of them) above the same rows Home uses, so any one can still be handled alone. */
  group(g: any, rowFor: (t: any) => unknown) {
    const expanded = this.open.has(g.key); const lines = (expanded ? g.items : g.items.slice(0, 3)) as any[];
    const hidden = g.count - g.items.length;
    // up to two answers: the one from a rule of yours, and the one from what you usually choose for this merchant
    const ruleSug = g.suggestions.find((p: any) => p.why === 'rule'), merchSug = g.suggestions.find((p: any) => p.why === 'merchant history' && p.id !== ruleSug?.id);
    const quick: any[] = [ruleSug, merchSug].filter(Boolean); if (!quick.length && g.suggestions[0]) quick.push(g.suggestions[0]);
    return html`<div class="card group flush" data-key=${g.key}><div class="grouphead"><div class="row"><b class="grow">${g.name}</b><span class="badge">${g.count} transaction${g.count === 1 ? '' : 's'}</span>${amt(g.totalCents)}</div>
      <div class="bulkbar"><span class="muted small">One answer for all ${g.count}:</span>
        ${catSelect(this.cats, null, (id) => { if (id) void this.answer(g, id); }, { placeholder: 'Search all categories…', reset: true })}
        ${quick.map((q) => html`<button class="primary" data-why=${q.why} title=${q.why === 'rule' ? 'Suggested by your rule' : q.why === 'merchant history' ? 'Suggested by what you usually choose for this merchant' : `Suggested: ${q.why}`} @click=${() => this.answer(g, q.id)}>Use ${q.name} for all ${g.count}</button>`)}</div></div>
      <div class="txnlist">${txnHead()}${lines.map(rowFor)}</div>
      ${g.count > 3 ? html`<div class="grouptail"><button class="link" @click=${() => { expanded ? this.open.delete(g.key) : this.open.add(g.key); this.requestUpdate(); }}>${expanded ? 'Show fewer' : `Show ${g.items.length === g.count ? `all ${g.count}` : `the first ${g.items.length} of ${g.count}`} transactions`}</button>${expanded && hidden > 0 ? html`<span class="muted small"> ${hidden} more are not listed; one answer above still covers all ${g.count}.</span>` : nothing}</div>` : nothing}</div>`;
  }
}
