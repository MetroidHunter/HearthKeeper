import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { pageHead, th, toast } from '../ui.js';

const PAGE = 25;
/** Ingest health + the Shapes page (design §8.7, §19.2). */
@customElement('hk-ingest')
export class Ingest extends Page {
  @state() health: any = null; @state() shapes: any[] = []; @state() events: any[] = []; @state() tab: 'events' | 'health' | 'shapes' = 'events'; @state() newToken: any = null;
  @state() list: { rows: any[]; total: number; sources: string[] } = { rows: [], total: 0, sources: [] }; @state() status = ''; @state() source = ''; @state() q = ''; @state() page = 0; @state() open: any = null; @state() spage = 0;
  private timer: any;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.health, this.shapes] = await Promise.all([api.get('/api/ingest/health'), api.get('/api/shapes')]); await this.loadList(); }); }
  async loadList() { const p = new URLSearchParams({ limit: String(PAGE), offset: String(this.page * PAGE) }); if (this.status) p.set('status', this.status); if (this.source) p.set('source', this.source); if (this.q) p.set('q', this.q); this.list = await api.get(`/api/ingest/list?${p}`); }
  /** Expand one event: fetches the full message only when you open it. */
  async toggle(id: number) { if (this.open?.id === id) { this.open = null; return; } this.open = { id, loading: true }; this.open = await this.run(() => api.get(`/api/ingest/events/${id}`)) ?? null; }
  async act(id: number, what: 'replay' | 'noise') { const r = await this.run(() => api.post(`/api/ingest/events/${id}/${what}`)); toast(what === 'noise' ? 'Marked as noise' : `Replayed: ${r?.result?.status ?? '?'}${r?.result?.error ? ` (${r.result.error})` : ''}`); this.open = null; await this.loadList(); }
  async decide(s: any, decision: string) { await this.run(() => api.post('/api/shapes/decide', { fingerprint: s.fingerprint, source: s.source, decision })); this.load(); }
  render() {
    return html`${pageHead('Ingest health', 'Whether automatic capture is working: Chase alerts, forwarded email, and Greenlight messages (only "allowance transferred to …" is used: it says which child a payment was for).', 'Every message that arrives is stored first and parsed second, so nothing is lost when a format changes. Messages it could not read are listed so you can see what changed.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="tabs">${(['events', 'shapes', 'health'] as const).map((t) => html`<button class=${this.tab === t ? 'primary' : ''} @click=${() => (this.tab = t)}>${{ events: 'Messages', shapes: 'Shapes', health: 'Sources & tokens' }[t]}</button>`)}
        <button @click=${async () => { const r = await this.run(() => api.post('/api/ingest/replay', { includeOk: false })); toast(`Replayed ${r?.replayed ?? 0}: ${Object.entries(r?.byStatus ?? {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}`); this.load(); }}>Replay unparsed</button></div>
      ${this.tab === 'events' ? this.eventsTab() : this.tab === 'shapes' ? this.shapesTab() : this.healthTab()}`;
  }
  pager(page: number, total: number, set: (n: number) => void) {
    const last = Math.max(0, Math.ceil(total / PAGE) - 1);
    return html`<div class="pager"><button ?disabled=${page <= 0} @click=${() => set(page - 1)}>← Previous</button><span class="muted">${total === 0 ? 'No results' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total.toLocaleString()}`}</span><button ?disabled=${page >= last} @click=${() => set(page + 1)}>Next →</button></div>`;
  }
  /** Every message ever received (they are all kept so a parser fix can replay them). Newest first, filterable, one line each; click a row for everything. */
  eventsTab() {
    const L = this.list; const refresh = () => this.run(() => this.loadList());
    return html`<div class="row"><select aria-label="Status" @change=${(e: any) => { this.status = e.target.value; this.page = 0; refresh(); }}>${[['', 'Any status'], ['unrecognized', 'Unrecognized'], ['error', 'Error'], ['pending', 'Pending'], ['ok', 'Parsed'], ['noise', 'Noise']].map(([v, l]) => html`<option value=${v} ?selected=${v === this.status}>${l}</option>`)}</select>
        <select aria-label="Source" @change=${(e: any) => { this.source = e.target.value; this.page = 0; refresh(); }}><option value="">Any source</option>${L.sources.map((x) => html`<option ?selected=${x === this.source}>${x}</option>`)}</select>
        <input class="grow" type="search" placeholder="Search text or sender" .value=${this.q} @input=${(e: any) => { this.q = e.target.value; this.page = 0; clearTimeout(this.timer); this.timer = setTimeout(refresh, 250); }} /></div>
      <div class="card flush evlist">${repeat(L.rows, (r: any) => r.id, (r: any) => this.eventRow(r))}${L.rows.length === 0 ? html`<div class="muted" style="padding:16px">Nothing matches.</div>` : nothing}</div>
      ${this.pager(this.page, L.total, (n) => { this.page = n; this.open = null; refresh(); })}`;
  }
  eventRow(r: any) {
    const o = this.open?.id === r.id ? this.open : null; const bad = ['unrecognized', 'error'].includes(r.parse_status);
    return html`<div class="evrow ${o ? 'open' : ''}"><button class="evhead" aria-expanded=${o ? 'true' : 'false'} @click=${() => this.toggle(r.id)}>
        <span class="evtime muted">${r.received_at.slice(5, 16).replace('T', ' ')}</span><span class="badge">${r.source}</span><span class="badge ${bad ? 'warn' : ''}">${r.parse_status}</span>
        <span class="evtext">${r.subject ?? r.preview}</span></button>
      ${o ? html`<div class="evbody">${o.loading ? html`<p class="muted">Loading…</p>` : html`
        <div class="muted small">#${o.id} · ${o.channel} · ${o.received_at} · parser ${o.parser_version ?? 'none'}${o.has_html ? ' · has HTML part' : ''}</div>
        ${o.error ? html`<p class="err">${o.error}</p>` : nothing}
        ${Object.keys(o.headers ?? {}).length ? html`<details><summary class="muted">Headers</summary><pre>${Object.entries(o.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre></details>` : nothing}
        <pre>${o.payload}</pre>
        <div class="row"><button @click=${() => this.act(o.id, 'replay')}>Replay this one</button>${['pending', 'unrecognized', 'error'].includes(o.parse_status) ? html`<button @click=${() => this.act(o.id, 'noise')}>Mark as noise</button>` : nothing}</div>`}</div>` : nothing}</div>`;
  }
  shapesTab() {
    return html`<p class="muted">Raw events cluster by template (numbers, dates, amounts and names replaced). Promote a cluster to a parser, or mark it noise.</p>
      ${this.shapes.slice(this.spage * PAGE, (this.spage + 1) * PAGE).map((s) => html`<div class="card"><div class="row"><span class="badge">${s.source}</span><b>${s.count}×</b><span class="muted">${s.first_seen?.slice(0, 10)} → ${s.last_seen?.slice(0, 10)}</span>${s.unparsed ? html`<span class="badge warn">${s.unparsed} unparsed</span>` : ''}${s.decision ? html`<span class="badge">${s.decision}</span>` : ''}
        <span class="right"><button @click=${() => this.decide(s, 'parser')}>Promote to parser</button> <button @click=${() => this.decide(s, 'noise')}>Noise</button> <button @click=${() => this.decide(s, 'needs_look')}>Needs a look</button></span></div>
        <pre class="shapefp">${s.fingerprint}</pre><details><summary class="muted">examples</summary>${s.examples.map((e: string) => html`<pre style="white-space:pre-wrap;font-size:12px">${e.slice(0, 600)}</pre>`)}</details></div>`)}
      ${this.shapes.length === 0 ? html`<div class="card muted">Nothing captured yet.</div>` : this.pager(this.spage, this.shapes.length, (n) => (this.spage = n))}`;
  }
  healthTab() {
    const h = this.health; if (!h) return '';
    return html`<div class="card"><table><thead><tr>${th('Source', 'Where messages come from.')}${th('Events', 'Messages received from it.', 'num')}${th('Last', 'When the most recent one arrived.')}${th('Pending', 'Received but not parsed yet.', 'num')}${th('Failed', 'Received but could not be read; they are kept and can be replayed.', 'num')}</tr></thead><tbody>${h.perSource.map((s: any) => html`<tr><td>${s.source}</td><td class="num">${s.events}</td><td>${s.last_event}</td><td class="num">${s.pending}</td><td class="num">${s.failed}</td></tr>`)}</tbody></table></div>
      <h2>Tokens</h2><div class="card">${h.tokens.map((t: any) => html`<div class="row"><b>${t.label}</b><span class="badge">${t.channel}</span><span class="muted">last seen ${t.last_seen_at ?? 'never'}</span>${h.silent.some((s: any) => s.id === t.id) ? html`<span class="badge bad">silent</span>` : ''}</div>`)}
        <div class="row" style="margin-top:8px"><button @click=${async () => { const label = prompt('Token label?'); if (!label) return; const ch = prompt('Channel (device or email)?', 'device'); this.newToken = await this.run(() => api.post('/api/ingest/tokens', { label, channel: ch, expectedCadenceHours: 72 })); this.load(); }}>＋ New token</button></div>
        ${this.newToken ? html`<p>Copy this secret now; it is shown once: <code>${this.newToken.secret}</code></p>` : ''}</div>`;
  }
}
