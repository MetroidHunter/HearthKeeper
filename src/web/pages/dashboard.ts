import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money } from '../api.js';

@customElement('hk-dashboard')
export class Dashboard extends Page {
  @state() d: any = null; @state() b: any = null;
  connectedCallback() { super.connectedCallback(); this.run(async () => { [this.d, this.b] = await Promise.all([api.get('/api/dashboard'), api.get('/api/budget')]); }); }
  render() {
    if (!this.d) return html`<p class="muted">${this.err || 'Loading…'}</p>`;
    const open = this.d.closeReadiness.filter((s: any) => !s.pass);
    const over = (this.b?.rows ?? []).filter((r: any) => r.kind === 'expense' && r.currentCents < 0);
    return html`<h1>Dashboard</h1>
      <div class="grid2"><div class="card"><div class="muted">Unallocated</div><b style="font-size:22px" class=${this.b?.header.unallocatedCents < 0 ? 'neg' : ''}>${money(this.b?.header.unallocatedCents)}</b></div>
        <div class="card"><div class="muted">Close readiness</div><b style="font-size:22px">${this.d.closeReadiness.length - open.length}/${this.d.closeReadiness.length}</b> ${open.map((s: any) => html`<span class="badge bad">${s.name} ${s.count}</span>`)}</div>
        <div class="card"><div class="muted">Overspent envelopes</div><b style="font-size:22px">${over.length}</b><div class="muted">${over.slice(0, 5).map((r: any) => `${r.name} ${money(r.currentCents)}`).join(' · ')}</div></div></div>
      <h2>Coverage</h2><div class="card">${this.d.coverage.map((c: any) => html`<div class="row"><span class="grow">${c.institution}</span><span class="muted">last transaction ${c.last_txn ?? 'never'}</span>${c.stale ? html`<span class="badge bad">stale</span>` : html`<span class="badge">ok</span>`}</div>`)}</div>
      ${this.d.silentSources.length ? html`<div class="card"><b class="err">Silent sources</b>${this.d.silentSources.map((s: any) => html`<div>${s.label}: quiet ${Number.isFinite(s.hoursSilent) ? `${Math.round(s.hoursSilent)}h` : 'since setup'}</div>`)}</div>` : ''}
      ${this.d.invariants.length ? html`<div class="card"><b class="err">Data invariants violated</b>${this.d.invariants.map((i: string) => html`<div>${i}</div>`)}</div>` : ''}`;
  }
}
