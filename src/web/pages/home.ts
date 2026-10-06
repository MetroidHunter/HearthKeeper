import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { amt, pace, type Cat } from '../shared.js';
import { pageHead, showDialog, catSelect } from '../ui.js';
import { txnCard, type Env } from '../txn.js';

/** Home: favorites first, then what needs a person (with the reason), then what just happened. */
@customElement('hk-home')
export class Home extends Page {
  @state() inbox: any = null; @state() budget: any = null; @state() recent: any[] = []; @state() cats: Cat[] = []; @state() q = ''; @state() accounts: any[] = [];
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() {
    await this.run(async () => {
      [this.inbox, this.budget, this.recent, this.cats, this.accounts] = await Promise.all([api.get('/api/inbox'), api.get('/api/budget'), api.get('/api/transactions?limit=20'), api.get('/api/categories'), api.get('/api/accounts')]);
    });
  }
  private env(): Env {
    return {
      cats: this.cats, rows: this.budget?.rows ?? [],
      categorize: async (ids, categoryId, makeRule) => { await this.run(async () => { for (const id of ids) await api.post(`/api/transactions/${id}/categorize`, { categoryId, makeRule: makeRule ? 'suggest' : undefined }); }); },
      ignore: async (t) => { await this.run(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'not a budget item' })); },
    };
  }
  async toggleFavorite(r: any) { await this.run(() => (r.favorite ? api.del(`/api/favorites/${r.id}`) : api.post('/api/favorites', { categoryId: r.id }))); this.load(); }
  render() {
    if (!this.inbox) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const c = this.inbox.counts;
    const rows: any[] = this.budget?.rows ?? [];
    const favs = rows.filter((r) => r.favorite);
    const shown = favs.length ? favs : rows.filter((r) => r.kind === 'expense').slice(0, 6);
    const need = [...this.inbox.needsCategory, ...this.inbox.flagged, ...this.inbox.needsNote, ...this.inbox.staleProvisionals].filter((t: any, i: number, a: any[]) => a.findIndex((x) => x.id === t.id) === i);
    const unc = this.budget?.uncategorized;
    const env = this.env();
    return html`${pageHead('Home', 'Your favorite envelopes, the things that need a decision from you, and what just happened.', 'Everything under "Needs you" says why it is there. Pick a category and you will see what it does to that category\'s budget before it is saved.')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="row"><input class="grow" type="search" placeholder="Search merchant, note, category" .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && (location.hash = `#/explore?q=${encodeURIComponent(this.q)}`)} />
        <button class="primary" @click=${() => this.addDialog()}>＋ Add transaction</button></div>

      <h2>Favorites</h2>
      <div class="grid3">${shown.map((r: any) => html`<div class="card"><div class="row"><b class="grow">${r.name}</b><button class="link icon" title=${r.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite" @click=${() => this.toggleFavorite(r)}>${r.favorite ? '★' : '☆'}</button></div>
        <div class="stat" style="border:0;padding:0"><span class="value ${r.currentCents < 0 ? 'neg' : ''}">${money(r.currentCents)}</span><span class="sub">balance</span></div>
        <div class="bar ${r.currentCents < 0 ? 'over' : ''}" style="margin-top:8px"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div>
        <div class="muted small" style="margin-top:4px">Spent ${money(r.spent[0])} of ${money(r.targetCents)} this month</div></div>`)}</div>
      ${favs.length ? nothing : html`<p class="muted small">Showing a few expense envelopes. Tap ☆ on any card (or on the Budget page) to pin your own.</p>`}

      <h2>Needs you</h2>
      <div class="card"><div class="row"><b style="font-size:20px">${c.total} item${c.total === 1 ? '' : 's'} need${c.total === 1 ? 's' : ''} a decision</b><span class="grow"></span><a href="#/backlog"><button>Open Backlog</button></a></div>
        <div class="list" style="margin-top:8px">
          <div class="list-row"><span class="grow">Need a category</span><b>${c.needsCategory}</b></div>
          <div class="list-row"><span class="grow">Flagged for follow-up</span><b>${c.flagged}</b></div>
          <div class="list-row"><span class="grow">Waiting on an Amazon/Venmo/PayPal note</span><b>${c.needsNote}</b></div>
          <div class="list-row"><span class="grow">Pending charges that never posted</span><b>${c.stale}</b></div></div>
        <p class="muted small" style="margin-bottom:0">One transaction can be in more than one group, so these add up to more than ${c.total}. The Backlog groups uncategorized items by merchant, so it shows fewer lines than this count.</p></div>
      ${unc && unc.count ? html`<div class="stat"><span class="label">Sitting in "Needs category"</span><span class="value ${unc.netCents < 0 ? 'neg' : ''}">${money(unc.netCents)}</span><span class="sub">${unc.count} transactions with no category (${money(unc.spendCents)} out, ${money(unc.incomeCents)} in). Categorizing one moves its amount out of here and into that category.</span></div>` : nothing}
      ${this.inbox.greenlightRequests.map((r: any) => html`<div class="card row"><div class="grow"><b>${r.display_name}</b> requests ${money(r.amount_cents)}</div><a href="#/greenlight"><button>Review</button></a></div>`)}
      ${need.length === 0 ? html`<div class="card muted">All caught up.</div>` : need.slice(0, 10).map((t: any) => txnCard(env, t, { reload: () => this.load() }))}
      ${need.length > 10 ? html`<div class="card row"><span class="grow muted">Showing the 10 most recent of ${need.length}${c.total > need.length ? ` (${c.total} in total)` : ''}.</span><a href="#/backlog"><button class="primary">Keep going in Backlog</button></a></div>` : nothing}

      <h2>Recent</h2>
      <div class="card flush"><div class="list hover">${this.recent.map((t: any) => html`<div class="list-row"><span class="muted" style="width:62px">${fmtDate(t.occurred_on)}</span>
        <span class="grow">${t.descriptor_clean || t.descriptor_raw} ${t.status === 'provisional' ? html`<span class="badge warn">pending</span>` : nothing}</span>
        <span class="muted hide-sm">${t.splits[0]?.category ?? ''}</span>${amt(t.amount_cents)}</div>`)}</div></div>`;
  }
  async addDialog() {
    let desc = '', cents = 0, cat: number | null = null, account = this.accounts[0]?.id ?? 1;
    await showDialog<boolean>((close) => html`<h3 class="title">Add a transaction</h3>
      <div class="stack"><div class="row"><input class="grow" placeholder="What was it?" @input=${(e: any) => (desc = e.target.value)} /><input style="width:7rem" inputmode="decimal" placeholder="12.50" @input=${(e: any) => (cents = -Math.round(parseFloat(e.target.value || '0') * 100))} /></div>
      <div class="row">${catSelect(this.cats, null, (id) => (cat = id), { placeholder: 'Category (type to search)' })}<select @change=${(e: any) => (account = Number(e.target.value))}>${this.accounts.map((a: any) => html`<option value=${a.id}>${a.name}</option>`)}</select></div></div>
      <div class="actions"><button @click=${() => close(false)}>Cancel</button><button class="primary save" @click=${async () => { await this.run(() => api.post('/api/transactions', { accountId: account, descriptor: desc || 'Manual entry', amountCents: cents, categoryId: cat || undefined })); close(true); }}>Save</button></div>`, { dismiss: false });
    this.load();
  }
}
