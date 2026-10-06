import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { amt, pace, type Cat } from '../shared.js';
import { showDialog, catSelect } from '../ui.js';
import { txnCard, type Env } from '../txn.js';

const FOLD = 'hk-home-attention-open';
const foldOpen = () => { try { return localStorage.getItem(FOLD) !== '0'; } catch { return true; } }; // remembered per device; open by default
const saveFold = (open: boolean) => { try { localStorage.setItem(FOLD, open ? '1' : '0'); } catch { /* private mode */ } };

/** Home: what needs a person first (collapsible), then favorites, then what just happened; searching and adding come last. */
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
      categorize: async (ids, categoryId, makeRule) => { for (const id of ids) await api.post(`/api/transactions/${id}/categorize`, { categoryId, makeRule: makeRule ? 'suggest' : undefined }); }, // errors surface in a dialog (txn.ts)
      ignore: async (t) => { await api.post(`/api/transactions/${t.id}/ignore`, { reason: 'not a budget item' }); },
    };
  }
  async toggleFavorite(r: any) { await this.run(() => (r.favorite ? api.del(`/api/favorites/${r.id}`) : api.post('/api/favorites', { categoryId: r.id }))); this.load(); }
  render() {
    if (!this.inbox) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const c = this.inbox.counts;
    const rows: any[] = this.budget?.rows ?? [];
    const favs = rows.filter((r) => r.favorite);
    const shown = favs.length ? favs : rows.filter((r) => r.kind === 'expense').slice(0, 6);
    const need: any[] = this.inbox.items;
    const unc = this.budget?.uncategorized;
    const env = this.env();
    const open = foldOpen();
    return html`<h1>Home</h1>
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}

      <details class="fold" ?open=${open} @toggle=${(e: Event) => saveFold((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><h2>Needs attention</h2><span class="badge ${c.total ? 'warn' : 'good'}">${c.total}</span><span class="fold-hint muted small">${c.total ? 'tap to collapse' : 'all caught up'}</span></summary>
        <div class="stack" style="margin-top:12px">
          <div class="card"><div class="row"><b style="font-size:18px">${c.total} item${c.total === 1 ? '' : 's'} need${c.total === 1 ? 's' : ''} a decision</b><span class="grow"></span><a href="#/backlog"><button>Open Backlog</button></a></div>
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
        </div>
      </details>

      <h2>Favorites</h2>
      <div class="favs">${shown.map((r: any) => html`<div class="fav ${r.currentCents < 0 ? 'over' : ''}" title="${r.name}: spent ${money(r.spent[0])} of ${money(r.targetCents)} this month">
        <div class="fav-top"><b class="fav-name">${r.name}</b><button class="link icon" title=${r.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite" @click=${() => this.toggleFavorite(r)}>${r.favorite ? '★' : '☆'}</button></div>
        <div class="fav-bal ${r.currentCents < 0 ? 'neg' : r.currentCents > 0 ? 'pos' : ''}">${money(r.currentCents)}</div>
        <div class="bar ${r.currentCents < 0 ? 'over' : ''}"><i style="width:${pace(r.spent[0], r.targetCents)}%"></i></div>
        <div class="fav-sub">${money(r.spent[0])} of ${money(r.targetCents)}</div></div>`)}</div>
      ${favs.length ? nothing : html`<p class="muted small">Showing a few expense envelopes. Pin your own with ☆ on the Budget page.</p>`}

      <h2>Recent</h2>
      <div class="card flush"><div class="list hover">${this.recent.map((t: any) => html`<div class="list-row"><span class="muted" style="width:62px">${fmtDate(t.occurred_on)}</span>
        <span class="grow">${t.descriptor_clean || t.descriptor_raw} ${t.status === 'provisional' ? html`<span class="badge warn">pending</span>` : nothing}${t.note ? html`<div class="muted small">${t.note}</div>` : nothing}</span>
        <span class="muted hide-sm">${t.splits[0]?.category ?? ''}</span>${amt(t.amount_cents)}</div>`)}</div></div>

      <div class="row"><input class="grow" type="search" placeholder="Search merchant, note, category" .value=${this.q} @input=${(e: any) => (this.q = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && (location.hash = `#/explore?q=${encodeURIComponent(this.q)}`)} />
        <button class="primary" @click=${() => this.addDialog()}>＋ Add transaction</button></div>`;
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
