import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { pageHead, th } from '../ui.js';

const LINKS: Record<string, string> = { Coverage: '#/imports', Uncategorized: '#/', Provisionals: '#/', Notes: '#/', Flags: '#/transactions', Duplicates: '#/transactions', Greenlight: '#/greenlight', Unrecognized: '#/ingest', Overages: '#/transfers', Pool: '#/transfers' };

@customElement('hk-close')
export class Close extends Page {
  @state() steps: any[] = []; @state() wallet = '';
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.steps = await api.get(`/api/close${this.wallet ? `?wallet=${Math.round(parseFloat(this.wallet) * 100)}` : ''}`); }); }
  render() {
    const done = this.steps.every((s) => s.pass);
    return html`${pageHead('Close the month', 'A checklist for finishing a month: everything categorized, accounts covered, Greenlight settled, overspending covered. Closing locks the month so old numbers stay put.', 'A closed month can be reopened if you need to fix something; that is recorded.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card">${this.steps.map((s) => html`<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${s.pass ? '✅' : '⬜'}</span><b class="grow">${s.step}. ${s.name}</b>
        ${s.count ? html`<span class="badge bad">${s.count}</span>` : ''}${s.detail ? html`<span class="muted">${s.detail}</span>` : ''}${!s.pass && LINKS[s.name] ? html`<a href=${LINKS[s.name]}>Fix →</a>` : ''}</div>`)}</div>
      <div class="card row"><label>Real Greenlight wallet balance (optional) <input style="width:8rem" placeholder="0.00" .value=${this.wallet} @change=${(e: any) => { this.wallet = e.target.value; this.load(); }} /></label>
        <button class="primary right" ?disabled=${!done} @click=${async () => { await this.run(() => api.post('/api/close', {})); alert('Period closed'); }}>${done ? 'Close period' : 'Resolve items to close'}</button></div>`;
  }
}
