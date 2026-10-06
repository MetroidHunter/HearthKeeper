import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, money, parseMoney } from '../api.js';
import { pageHead, th } from '../ui.js';

@customElement('hk-earnings')
export class Earnings extends Page {
  @state() scenarios: any[] = []; @state() draft: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { this.scenarios = await api.get('/api/scenarios'); }); }
  net(l: any) { const g = Math.round(l.annualSalaryCents * (l.workTimeBp ?? 10000) / 10000); return Math.round(g * (10000 - l.taxRateBp) / 10000); }
  edit(s?: any) { this.draft = s ? { id: s.id, name: s.name, lines: s.lines.map((l: any) => ({ ...l })) } : { name: 'New scenario', lines: [{ person: 'Brys', label: 'Salary', annualSalaryCents: 0, workTimeBp: 10000, taxRateBp: 3200, recurring: true }] }; }
  async save() { const d = this.draft; await this.run(async () => { if (d.id) await api.put(`/api/scenarios/${d.id}/lines`, { lines: d.lines }); else await api.post('/api/scenarios', { name: d.name, lines: d.lines }); this.draft = null; await this.load(); }); }
  render() {
    return html`${pageHead('Earnings', 'Income scenarios: salary, work time and tax assumptions that add up to the monthly income your budget is built on.', 'Make a scenario for a raise or a job change and compare it before attaching it to a plan. One-time income (bonuses) is listed but not counted in monthly income.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="row" style="margin-bottom:10px"><button class="primary" @click=${() => this.edit()}>＋ New scenario</button></div>
      ${this.draft ? this.editor() : ''}
      ${this.scenarios.map((s) => html`<div class="card"><div class="row"><b class="grow">${s.name}</b><span>${money(s.monthlyNetCents)}/mo net</span><button @click=${() => this.edit(s)}>Edit</button>
        <button @click=${async () => { const n = prompt('Clone as', `${s.name} (copy)`); if (n) { await this.run(() => api.post(`/api/scenarios/${s.id}/clone`, { name: n })); this.load(); } }}>Clone</button></div>
        <table><thead><tr>${th('Line', 'A source of income in this scenario.')}${th('Gross/yr', 'Yearly pay before tax at full time.', 'num')}${th('Work', 'Share of full time worked.', 'num')}${th('Tax', 'Effective tax rate applied.', 'num')}${th('Net/yr', 'Gross times work share, after tax.', 'num')}${th('Net/mo', 'Net per year divided by twelve: what the budget counts on.', 'num')}${th('Bi-weekly', 'Net per two-week paycheck.', 'num hide-sm')}</tr></thead><tbody>
          ${s.lines.map((l: any) => html`<tr><td>${l.person ? `${l.person}: ` : ''}${l.label}${l.recurring ? '' : html` <span class="badge">one-time</span>`}</td><td class="num">${money(l.annualSalaryCents)}</td><td class="num">${(l.workTimeBp / 100).toFixed(0)}%</td><td class="num">${(l.taxRateBp / 100).toFixed(1)}%</td><td class="num">${money(l.netAnnual)}</td><td class="num">${money(l.monthlyNet)}</td><td class="num hide-sm">${money(l.biWeekly)}</td></tr>`)}</tbody></table></div>`)}`;
  }
  editor() {
    const d = this.draft;
    return html`<div class="card"><div class="row"><input class="grow" .value=${d.name} ?disabled=${!!d.id} @input=${(e: any) => (d.name = e.target.value)} /></div>
      ${d.lines.map((l: any, i: number) => html`<div class="row" style="margin-top:8px"><input style="width:6rem" placeholder="Person" .value=${l.person ?? ''} @input=${(e: any) => (l.person = e.target.value)} /><input style="width:7rem" placeholder="Label" .value=${l.label} @input=${(e: any) => (l.label = e.target.value)} />
        <label class="muted">Gross <input style="width:8rem" .value=${(l.annualSalaryCents / 100).toFixed(2)} @input=${(e: any) => { l.annualSalaryCents = parseMoney(e.target.value || '0'); this.requestUpdate(); }} /></label>
        <label class="muted">Work % <input style="width:4rem" .value=${String(l.workTimeBp / 100)} @input=${(e: any) => { l.workTimeBp = Math.round(parseFloat(e.target.value || '0') * 100); this.requestUpdate(); }} /></label>
        <label class="muted">Tax % <input style="width:4rem" .value=${String(l.taxRateBp / 100)} @input=${(e: any) => { l.taxRateBp = Math.round(parseFloat(e.target.value || '0') * 100); this.requestUpdate(); }} /></label>
        <label class="muted"><input type="checkbox" .checked=${l.recurring} @change=${(e: any) => (l.recurring = e.target.checked)} /> recurring</label>
        <b>${money(Math.round(this.net(l) / 12))}/mo · ${money(Math.round(this.net(l) / 26))} bi-weekly</b><button @click=${() => { d.lines.splice(i, 1); this.requestUpdate(); }}>✕</button></div>`)}
      <div class="row" style="margin-top:10px"><button @click=${() => { d.lines.push({ label: 'Line', annualSalaryCents: 0, workTimeBp: 10000, taxRateBp: 3200, recurring: true }); this.requestUpdate(); }}>＋ line</button><button @click=${() => (this.draft = null)}>Cancel</button><button class="primary" @click=${() => this.save()}>Save</button></div></div>`;
  }
}
