import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { pageHead, th } from '../ui.js';

/** Ingest health + the Shapes page (design §8.7, §19.2). */
@customElement('hk-ingest')
export class Ingest extends Page {
  @state() health: any = null; @state() shapes: any[] = []; @state() events: any[] = []; @state() tab: 'health' | 'shapes' | 'dead' = 'shapes'; @state() newToken: any = null;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.health, this.shapes, this.events] = await Promise.all([api.get('/api/ingest/health'), api.get('/api/shapes'), api.get('/api/ingest/events?status=unrecognized')]); }); }
  async decide(s: any, decision: string) { await this.run(() => api.post('/api/shapes/decide', { fingerprint: s.fingerprint, source: s.source, decision })); this.load(); }
  render() {
    return html`${pageHead('Ingest health', 'Whether automatic capture is working: Chase alerts, Greenlight messages and forwarded email.', 'Every message that arrives is stored first and parsed second, so nothing is lost when a format changes. Messages it could not read are listed so you can see what changed.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="tabs">${(['shapes', 'health', 'dead'] as const).map((t) => html`<button class=${this.tab === t ? 'primary' : ''} @click=${() => (this.tab = t)}>${{ shapes: 'Shapes', health: 'Sources & tokens', dead: 'Unrecognized' }[t]}</button>`)}
        <button @click=${async () => { const r = await this.run(() => api.post('/api/ingest/replay', { includeOk: false })); alert(JSON.stringify(r)); this.load(); }}>Replay unparsed</button></div>
      ${this.tab === 'shapes' ? this.shapesTab() : this.tab === 'health' ? this.healthTab() : this.deadTab()}`;
  }
  shapesTab() {
    return html`<p class="muted">Raw events cluster by template (numbers, dates, amounts and names replaced). Promote a cluster to a parser, or mark it noise.</p>
      ${this.shapes.map((s) => html`<div class="card"><div class="row"><span class="badge">${s.source}</span><b>${s.count}×</b><span class="muted">${s.first_seen?.slice(0, 10)} → ${s.last_seen?.slice(0, 10)}</span>${s.unparsed ? html`<span class="badge warn">${s.unparsed} unparsed</span>` : ''}${s.decision ? html`<span class="badge">${s.decision}</span>` : ''}
        <span class="right"><button @click=${() => this.decide(s, 'parser')}>Promote to parser</button> <button @click=${() => this.decide(s, 'noise')}>Noise</button> <button @click=${() => this.decide(s, 'needs_look')}>Needs a look</button></span></div>
        <pre style="white-space:pre-wrap;margin:6px 0;font-size:12px">${s.fingerprint}</pre><details><summary class="muted">examples</summary>${s.examples.map((e: string) => html`<pre style="white-space:pre-wrap;font-size:12px">${e.slice(0, 600)}</pre>`)}</details></div>`)}
      ${this.shapes.length === 0 ? html`<div class="card muted">Nothing captured yet.</div>` : ''}`;
  }
  healthTab() {
    const h = this.health; if (!h) return '';
    return html`<div class="card"><table><thead><tr>${th('Source', 'Where messages come from.')}${th('Events', 'Messages received from it.', 'num')}${th('Last', 'When the most recent one arrived.')}${th('Pending', 'Received but not parsed yet.', 'num')}${th('Failed', 'Received but could not be read; they are kept and can be replayed.', 'num')}</tr></thead><tbody>${h.perSource.map((s: any) => html`<tr><td>${s.source}</td><td class="num">${s.events}</td><td>${s.last_event}</td><td class="num">${s.pending}</td><td class="num">${s.failed}</td></tr>`)}</tbody></table></div>
      <h2>Tokens</h2><div class="card">${h.tokens.map((t: any) => html`<div class="row"><b>${t.label}</b><span class="badge">${t.channel}</span><span class="muted">last seen ${t.last_seen_at ?? 'never'}</span>${h.silent.some((s: any) => s.id === t.id) ? html`<span class="badge bad">silent</span>` : ''}</div>`)}
        <div class="row" style="margin-top:8px"><button @click=${async () => { const label = prompt('Token label?'); if (!label) return; const ch = prompt('Channel (device or email)?', 'device'); this.newToken = await this.run(() => api.post('/api/ingest/tokens', { label, channel: ch, expectedCadenceHours: 72 })); this.load(); }}>＋ New token</button></div>
        ${this.newToken ? html`<p>Copy this secret now; it is shown once: <code>${this.newToken.secret}</code></p>` : ''}</div>`;
  }
  deadTab() {
    return html`${this.events.map((e) => html`<div class="card"><div class="row"><span class="badge">${e.source}</span><span class="muted">${e.received_at}</span><span class="err">${e.error ?? ''}</span></div><pre style="white-space:pre-wrap;font-size:12px">${e.payload.slice(0, 800)}</pre></div>`)}${this.events.length === 0 ? html`<div class="card muted">Nothing unrecognized.</div>` : ''}`;
  }
}
