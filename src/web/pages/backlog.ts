import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { amt, type Cat } from '../shared.js';
import { pageHead, catSelect, alertBox } from '../ui.js';
import { txnCard, confirmCategorize, showContext, fullLine, type Env } from '../txn.js';

/** Backlog (design §8.3): the same decisions as Home, in bulk. Uncategorized items by merchant, plus flagged and note items one by one. */
@customElement('hk-backlog')
export class Backlog extends Page {
  @state() groups: any[] = []; @state() cats: Cat[] = []; @state() rows: any[] = []; @state() inbox: any = null; @state() view: 'merchants' | 'flagged' | 'notes' = 'merchants'; @state() last = ''; @state() filter = ''; @state() open = new Set<string>();
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { let b: any; [this.groups, this.cats, b, this.inbox] = await Promise.all([api.get('/api/inbox/grouped'), api.get('/api/categories'), api.get('/api/budget'), api.get('/api/inbox')]); this.rows = b.rows; }); }
  private env(): Env {
    return { cats: this.cats, rows: this.rows,
      categorize: async (ids, categoryId, makeRule) => { for (const id of ids) await api.post(`/api/transactions/${id}/categorize`, { categoryId, makeRule: makeRule ? 'suggest' : undefined }); },
      ignore: async (t) => { await api.post(`/api/transactions/${t.id}/ignore`, { reason: 'not a budget item' }); } };
  }
  async answer(g: any, categoryId: number, sug?: { why: string }) {
    const { ok, remember } = await confirmCategorize(this.env(), [{ id: g.txnIds[0], occurred_on: g.txns[0]?.occurred_on ?? '', amount_cents: g.totalCents, descriptor_raw: g.name, account: '' }], categoryId, { groupName: g.name, count: g.count, defaultRemember: !!g.merchantId && (!sug || sug.why !== 'rule') });
    if (!ok) return;
    try {
      const r = await api.post('/api/inbox/bulk', { txnIds: g.txnIds, categoryId, makeRule: remember && g.merchantId ? 'suggest' : undefined });
      this.last = `${g.name}: ${r.applied} categorized${r.skipped ? `, ${r.skipped} skipped (already answered)` : ''}${r.rule ? `; the new rule would have matched ${r.rule.backtest.matched} past transactions` : ''}`;
    } catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); }
    await this.load();
  }
  render() {
    const c = this.inbox?.counts;
    const tab = (v: 'merchants' | 'flagged' | 'notes', label: string) => html`<button aria-pressed=${this.view === v} @click=${() => (this.view = v)}>${label}</button>`;
    return html`${pageHead('Backlog', 'Everything waiting on a decision, in bulk. Uncategorized transactions are grouped by merchant so one answer settles every transaction from it.', 'Flagged items (your "???" notes and other follow-ups) and items waiting on an Amazon, Venmo or PayPal note are listed one by one in their own tabs.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="tabs">${tab('merchants', `By merchant (${this.groups.length})`)}${tab('flagged', `Flagged (${c?.flagged ?? 0})`)}${tab('notes', `Waiting on notes (${c?.needsNote ?? 0})`)}</div>
      ${this.last ? html`<p class="muted" role="status">${this.last}</p>` : nothing}
      ${this.view === 'merchants' ? this.merchants() : this.view === 'flagged' ? this.items((this.inbox?.items ?? []).filter((t: any) => t.reasons.some((r: any) => r.reason === 'flagged')), 'Nothing is flagged.') : this.items((this.inbox?.items ?? []).filter((t: any) => t.reasons.some((r: any) => r.reason === 'needs_note')), 'No notes are being waited on.')}`;
  }
  items(list: any[], empty: string) {
    const env = this.env();
    return html`${list.length === 0 ? html`<div class="card muted">${empty}</div>` : list.slice(0, 50).map((t) => txnCard(env, t, { reload: () => this.load() }))}
      ${list.length > 50 ? html`<p class="muted">Showing 50 of ${list.length}; the rest appear as you resolve these.</p>` : nothing}`;
  }
  merchants() {
    const gs = this.groups.filter((g) => !this.filter || g.name.toLowerCase().includes(this.filter.toLowerCase()));
    const n = this.groups.reduce((a, g) => a + g.count, 0);
    return html`<div class="card row"><b>${n} transactions in ${this.groups.length} merchants</b><input class="grow" type="search" placeholder="Filter merchants" @input=${(e: any) => (this.filter = e.target.value)} /></div>
      ${gs.length === 0 ? html`<div class="card muted">Nothing waiting.</div>` : gs.slice(0, 40).map((g) => this.group(g))}
      ${gs.length > 40 ? html`<p class="muted">Showing the 40 biggest of ${gs.length} merchants. Filter, or settle these first.</p>` : nothing}`;
  }
  /**
   * One merchant: a bulk bar (one answer for all of them) above the same per-transaction cards Home uses, so a single transaction can still be
   * handled on its own (its own category, note or "not a budget item") without leaving the group.
   */
  group(g: any) {
    const expanded = this.open.has(g.key); const byId = new Map<number, any>((this.inbox?.items ?? []).map((t: any) => [t.id, t]));
    const lines = (expanded ? g.txns : g.txns.slice(0, 3)) as any[]; const env = this.env();
    const best = g.suggestions[0];
    const only = g.count === 1 ? byId.get(g.txnIds[0]) : null;
    if (only) return txnCard(env, only, { reload: () => this.load() }); // one transaction: just the card, exactly as on Home
    return html`<div class="card group" data-key=${g.key}><div class="row"><b class="grow">${g.name}</b><span class="badge">${g.count} transaction${g.count === 1 ? '' : 's'}</span>${amt(g.totalCents)}</div>
      <div class="bulkbar"><span class="muted small">${g.count === 1 ? 'Category for this one:' : `One answer for all ${g.count}:`}</span>
        ${catSelect(this.cats, null, (id) => { if (id) void this.answer(g, id); }, { placeholder: 'Search all categories…' })}
        ${best ? html`<button class="primary" title=${best.why} @click=${() => this.answer(g, best.id, best)}>Use ${best.name}${g.count > 1 ? ` for all ${g.count}` : ''}</button>` : nothing}</div>
      <div class="stack" style="margin-top:10px">${lines.map((t: any) => { const full = byId.get(t.id); return full ? txnCard(env, full, { reload: () => this.load() }) : html`<div class="row"><div class="grow">${fullLine({ ...t, account: t.account })}</div><button class="icon" title="Show the transactions around this one" @click=${() => showContext({ ...t, account: t.account })}>Nearby</button></div>`; })}
        ${g.count > 3 ? html`<button class="link" @click=${() => { expanded ? this.open.delete(g.key) : this.open.add(g.key); this.requestUpdate(); }}>${expanded ? 'Show fewer' : `Show all ${Math.min(g.count, g.txns.length)}${g.count > g.txns.length ? ` of ${g.count}` : ''} transactions`}</button>` : nothing}</div></div>`;
  }
}
