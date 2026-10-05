import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';
import { catOptions, type Cat } from '../shared.js';

/** Backlog mode (design §8.3): review by merchant, one answer applies to the whole group. */
@customElement('hk-backlog')
export class Backlog extends Page {
  @state() groups: any[] = []; @state() cats: Cat[] = []; @state() learn = true; @state() last = ''; @state() filter = '';
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.groups, this.cats] = await Promise.all([api.get('/api/inbox/grouped'), api.get('/api/categories')]); }); }
  async answer(g: any, categoryId: number) {
    await this.run(async () => {
      const r = await api.post('/api/inbox/bulk', { txnIds: g.txnIds, categoryId, makeRule: this.learn && g.merchantId ? 'suggest' : undefined });
      this.last = `${g.name}: ${r.applied} categorized${r.rule ? `; new rule would have matched ${r.rule.backtest.matched} past transactions` : ''}`;
      await this.load();
    });
  }
  render() {
    const gs = this.groups.filter((g) => !this.filter || g.name.toLowerCase().includes(this.filter.toLowerCase()));
    const n = this.groups.reduce((a, g) => a + g.count, 0);
    return html`<h1>Backlog review</h1>${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card row"><b>${n} transactions in ${this.groups.length} merchants</b><input class="grow" type="search" placeholder="Filter merchants" @input=${(e: any) => (this.filter = e.target.value)} />
        <label><input type="checkbox" id="learn" .checked=${this.learn} @change=${(e: any) => (this.learn = e.target.checked)} /> Remember as a rule (suggest mode)</label></div>
      ${this.last ? html`<p class="muted" role="status">${this.last}</p>` : ''}
      ${gs.length === 0 ? html`<div class="card muted">Nothing waiting.</div>` : gs.slice(0, 60).map((g) => html`<div class="card group"><div class="row"><b class="grow">${g.name}</b><span class="badge">${g.count}×</span><span class="mono ${g.totalCents < 0 ? 'neg' : 'pos'}">${money(g.totalCents)}</span></div>
        <div class="muted" style="font-size:12px">${g.samples.join(' · ').slice(0, 140)}</div>
        <div class="row" style="margin-top:6px">${g.suggestions.map((s: any, i: number) => html`<button class=${i === 0 ? 'chip primary' : 'chip'} title=${s.why} @click=${() => this.answer(g, s.id)}>${s.name}${i === 0 ? ' ✓' : ''}</button>`)}
          <select @change=${(e: any) => e.target.value && this.answer(g, Number(e.target.value))}>${catOptions(this.cats, null, { blank: 'Other…' })}</select></div></div>`)}`;
  }
}
