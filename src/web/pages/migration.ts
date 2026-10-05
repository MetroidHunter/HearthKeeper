import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { catOptions, type Cat } from '../shared.js';

/** Migration review (design D32, §18.4): the import's data-quality report plus the resolution worksheet for NEEDS CATEGORY / blank leftovers. */
@customElement('hk-migration')
export class Migration extends Page {
  @state() data: any = null; @state() cats: Cat[] = []; @state() choice: Record<number, number> = {}; @state() result: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.data, this.cats] = await Promise.all([api.get('/api/migration'), api.get('/api/categories')]); }); }
  acceptAll() { for (const i of this.data.worksheet) if (i.best && !this.choice[i.splitId]) this.choice[i.splitId] = i.best; this.requestUpdate(); }
  async apply() {
    const assignments = Object.entries(this.choice).filter(([, c]) => c).map(([splitId, categoryId]) => ({ splitId: Number(splitId), categoryId }));
    await this.run(async () => { this.result = await api.post('/api/migration/apply', { assignments }); this.choice = {}; await this.load(); });
  }
  list(title: string, rows: string[]) { return rows?.length ? html`<div class="card"><b>${title} (${rows.length})</b><div class="muted">${rows.slice(0, 40).join(' · ')}</div></div>` : ''; }
  render() {
    const d = this.data; if (!d) return html`<h1>Migration</h1><p class="muted">${this.err || 'Loading…'}</p>`;
    const r = d.report;
    return html`<h1>Migration</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      ${r ? html`<h2>What the import found</h2>
        <div class="grid2"><div class="card"><div class="muted">Transactions imported</div><b style="font-size:22px">${r.transactionsImported?.toLocaleString()}</b></div>
          <div class="card"><div class="muted">Legacy reallocations (Reingest / Zero Out / Ingest)</div><b style="font-size:22px">${typeof r.reallocationRows === 'number' ? r.reallocationRows.toLocaleString() : r.reallocationRows?.length}</b></div>
          <div class="card"><div class="muted">Text flags carried over</div><b style="font-size:22px">${r.noteFlags}</b></div></div>
        ${this.list('History rows the sheet silently ignores', (r.droppedHistoryRows ?? []).map((h: any) => `${h.category} (stop ${h.stop}, ${money(h.amountCents)})`))}
        ${this.list('Categories that look retired but are not flagged', r.likelyRetiredButUnflagged)}
        ${this.list('Categories used in Transactions but missing from List', r.categoriesMissingFromList)}
        ${this.list('Duplicate Budget rows (the sheet double-counts them)', r.duplicateBudgetRows)}
        ${this.list('Stray text in Budget', r.strayBudgetRows)}
        ${this.list('Categories missing a start date', r.categoriesMissingStart)}
        ${this.list('Split groups that do not add up to their Split Total', (r.legacySplitGroups ?? []).map((g: any) => `${g.key.split('|').slice(0, 2).join(' ')} (${g.rows} rows)`))}` : html`<div class="card muted">No migration has been run on this database.</div>`}
      <h2>Resolve what's still parked (${d.worksheet.length} · ${money(d.total)})</h2>
      ${this.result ? html`<div class="card"><b>Applied ${this.result.applied}</b> ${this.result.skipped ? html`<span class="badge warn">${this.result.skipped} skipped</span>` : ''}
        <table><thead><tr><th>Category</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr></thead><tbody>
        ${this.result.balances.map((b: any) => html`<tr><td>${b.name}</td><td class="num">${money(b.before)}</td><td class="num">${money(b.after)}</td><td class="num">${money(b.after - b.before, { sign: true })}</td></tr>`)}</tbody></table></div>` : ''}
      ${d.worksheet.length === 0 ? html`<div class="card muted">Nothing left to resolve.</div>` : html`
        <div class="row" style="margin-bottom:8px"><button id="accept-all" @click=${() => this.acceptAll()}>Accept top suggestions</button><button class="primary" id="apply" ?disabled=${!Object.values(this.choice).some(Boolean)} @click=${() => this.apply()}>Apply ${Object.values(this.choice).filter(Boolean).length} assignments</button>
          <span class="muted">An audited edit, separate from the import. Balances of every category it touches are shown afterwards.</span></div>
        <div class="card" style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>Was</th><th>Category</th></tr></thead><tbody>
          ${d.worksheet.map((i: any) => html`<tr><td>${fmtDate(i.date)}</td><td>${i.descriptor.slice(0, 60)}</td><td class="num ${i.amountCents < 0 ? 'neg' : 'pos'}">${money(i.amountCents)}</td><td><span class="badge">${i.bucket}</span></td>
            <td><div class="row">${i.suggestions.map((s: any, k: number) => html`<button class=${this.choice[i.splitId] === s.id ? 'chip primary' : 'chip'} title=${s.why} @click=${() => { this.choice[i.splitId] = s.id; this.requestUpdate(); }}>${s.name}${k === 0 ? ' ✓' : ''}</button>`)}
              <select @change=${(e: any) => { this.choice[i.splitId] = Number(e.target.value); this.requestUpdate(); }}>${catOptions(this.cats, this.choice[i.splitId] ?? null, { blank: 'Other…' })}</select></div></td></tr>`)}
        </tbody></table></div>`}`;
  }
}
