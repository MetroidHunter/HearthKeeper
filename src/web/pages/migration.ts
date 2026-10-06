import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, fmtDate } from '../api.js';
import { type Cat } from '../shared.js';
import { pageHead, th, catSelect } from '../ui.js';

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
  list(title: string, rows: string[]) { return rows?.length ? html`<div class="card"><h3>${title} (${rows.length})</h3><div class="list" style="margin-top:8px">${rows.slice(0, 15).map((r) => html`<div class="small">${r}</div>`)}</div>${rows.length > 15 ? html`<p class="muted small" style="margin-bottom:0">and ${rows.length - 15} more.</p>` : nothing}</div>` : nothing; }
  render() {
    const d = this.data; if (!d) return html`${pageHead('Migration', 'What the spreadsheet import found, and the leftovers it could not categorize.')}<p class="muted">${this.err || 'Loading…'}</p>`;
    const r = d.report;
    return html`${pageHead('Migration', 'A report of what the one-time import from your spreadsheet found, and a worksheet for the transactions it could not categorize.', 'The import is proven first: your balances matched the sheet to the cent before anything was cleaned up. Resolving leftovers below is a separate, audited edit, and afterwards you see the before and after balance of every category it touched.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
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
        <table><thead><tr>${th('Category', 'A category the cleanup moved money into or out of.')}${th('Before', 'Balance before the cleanup.', 'num')}${th('After', 'Balance after.', 'num')}${th('Change', 'The difference.', 'num')}</tr></thead><tbody>
        ${this.result.balances.map((b: any) => html`<tr><td>${b.name}</td><td class="num">${money(b.before)}</td><td class="num">${money(b.after)}</td><td class="num">${money(b.after - b.before, { sign: true })}</td></tr>`)}</tbody></table></div>` : ''}
      ${d.worksheet.length === 0 ? html`<div class="card muted">Nothing left to resolve.</div>` : html`
        <div class="row"><button id="accept-all" @click=${() => this.acceptAll()}>Accept top suggestions</button><button class="primary" id="apply" ?disabled=${!Object.values(this.choice).some(Boolean)} @click=${() => this.apply()}>Apply ${Object.values(this.choice).filter(Boolean).length} assignments</button>
          <span class="muted">An audited edit, separate from the import. Balances of every category it touches are shown afterwards.</span></div>
        <div class="stack">${d.worksheet.map((i: any) => html`<div class="card ws" data-split=${i.splitId}><div class="row"><b class="grow">${i.descriptor}</b><span class="mono ${i.amountCents < 0 ? 'neg' : 'pos'}">${money(i.amountCents)}</span></div>
          <div class="muted small">${fmtDate(i.date)} · was <span class="badge">${i.bucket}</span>${this.choice[i.splitId] ? html` · chosen: <b>${this.cats.find((c) => c.id === this.choice[i.splitId])?.name}</b>` : nothing}</div>
          <div class="option-list" style="margin-top:10px">${i.suggestions.map((s: any, k: number) => html`<button class="option ${this.choice[i.splitId] === s.id ? 'best' : ''}" aria-pressed=${this.choice[i.splitId] === s.id} @click=${() => { this.choice[i.splitId] = s.id; this.requestUpdate(); }}><span class="name">${s.name}</span>${k === 0 ? html`<span class="tag">Best match</span>` : nothing}<span class="muted small">${s.why}</span>${this.choice[i.splitId] === s.id ? html`<span class="meta">✓ chosen</span>` : nothing}</button>`)}</div>
          <div class="row" style="margin-top:10px"><span class="muted small">Something else:</span>${catSelect(this.cats, this.choice[i.splitId] ?? null, (id) => { if (id) this.choice[i.splitId] = id; else delete this.choice[i.splitId]; this.requestUpdate(); }, { placeholder: 'Search all categories…' })}</div></div>`)}</div>`}`;
  }
}
