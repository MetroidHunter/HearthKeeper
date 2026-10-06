import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { pageHead, th } from '../ui.js';

interface FileItem { name: string; text: string }

/** CSV upload (design §8.3): drag-and-drop, mapping wizard on first sight of a layout, preview before commit, coverage. */
@customElement('hk-imports')
export class Imports extends Page {
  @state() institution = 'Chase'; @state() files: FileItem[] = []; @state() preview: any = null; @state() mapping: any = null; @state() result: any = null; @state() coverage: any[] = []; @state() kind: 'bank' | 'notes' = 'bank'; @state() notesSource = 'amazon'; @state() drag = false;
  connectedCallback() { super.connectedCallback(); this.cov(); }
  async cov() { await this.run(async () => { this.coverage = await api.get('/api/coverage'); }); }
  async take(list: FileList | null) {
    if (!list) return;
    this.files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    this.result = null; this.mapping = null; await this.doPreview();
  }
  async doPreview() {
    this.preview = null;
    if (this.kind === 'notes') { this.preview = { notes: true, files: this.files.length }; return; }
    const f = this.files[0]; if (!f) return;
    await this.run(async () => {
      const p = await api.post('/api/imports/preview', { institution: this.institution, csv: f.text, spec: this.mapping ?? undefined });
      if (p.profileId === null) { this.mapping = { columnMap: p.suggested.columnMap, dateFormat: p.suggested.dateFormat, signRule: p.suggested.signRule, skipRows: 0 }; this.preview = { needsMapping: true, header: f.text.split('\n').slice(0, 4) }; }
      else this.preview = p;
    });
  }
  async commit() {
    await this.run(async () => {
      const agg = { imported: 0, alreadyImported: 0, supersededProvisionals: 0, categorized: 0, needsCategory: 0, transferPairs: 0 } as Record<string, number>;
      for (const f of this.files) {
        if (this.kind === 'notes') { const r = await api.post('/api/imports/notes', { csv: f.text, source: this.notesSource }); agg.imported += r.imported; agg.matched = (agg.matched ?? 0) + r.matched; continue; }
        const r = await api.post('/api/imports/commit', { institution: this.institution, csv: f.text, spec: this.mapping ?? undefined, filename: f.name });
        for (const k of Object.keys(agg)) agg[k] += r[k] ?? 0;
      }
      this.result = agg; this.files = []; this.preview = null; this.cov();
    });
  }
  colSel(key: string, label: string) {
    const m = this.mapping.columnMap, hdr = this.files[0].text.split('\n')[0].split(',');
    return html`<label class="muted">${label} <select @change=${(e: any) => { const v = e.target.value; m[key] = v === '' ? undefined : m.hasHeader ? v : Number(v); }}><option value="">—</option>${hdr.map((h, i) => html`<option value=${m.hasHeader ? h.trim() : i} ?selected=${m[key] === (m.hasHeader ? h.trim() : i)}>${m.hasHeader ? h.trim() : `col ${i + 1}`}</option>`)}</select></label>`;
  }
  render() {
    return html`${pageHead('Imports', 'Bring in bank transactions from CSV files, and notes from Amazon, Venmo and PayPal exports.', 'The first time a file layout shows up you tell it which column is the date, amount and description; that choice is remembered. Duplicates are skipped, pending charges are matched to the posted ones when they arrive, and transfers between your own accounts are detected and hidden. Nothing is changed until you confirm the preview.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <div class="card"><b>Coverage</b>${this.coverage.map((c) => html`<div class="row"><span class="grow">${c.institution}</span><span class="muted">last txn ${c.last_txn ?? 'never'} · last upload ${c.last_upload ?? 'never'}</span>${c.stale ? html`<span class="badge bad">stale</span>` : html`<span class="badge">ok</span>`}</div>`)}</div>
      <div class="tabs"><button class=${this.kind === 'bank' ? 'primary' : ''} @click=${() => { this.kind = 'bank'; this.preview = null; }}>Bank / card CSV</button><button class=${this.kind === 'notes' ? 'primary' : ''} @click=${() => { this.kind = 'notes'; this.preview = null; }}>Amazon / Venmo / PayPal notes CSV</button></div>
      <div class="card" style="border-style:dashed;text-align:center;padding:28px ${this.drag ? ';background:var(--chip)' : ''}" @dragover=${(e: DragEvent) => { e.preventDefault(); this.drag = true; }} @dragleave=${() => (this.drag = false)} @drop=${(e: DragEvent) => { e.preventDefault(); this.drag = false; this.take(e.dataTransfer?.files ?? null); }}>
        <div>Drop one or more CSV files here, or <input type="file" accept=".csv,text/csv" multiple @change=${(e: any) => this.take(e.target.files)} /></div>
        ${this.kind === 'bank' ? html`<div style="margin-top:8px"><select @change=${(e: any) => { this.institution = e.target.value; this.mapping = null; this.doPreview(); }}>${['Chase', 'Wells Fargo'].map((i) => html`<option ?selected=${i === this.institution}>${i}</option>`)}</select></div>` : html`<div style="margin-top:8px"><select @change=${(e: any) => (this.notesSource = e.target.value)}>${['amazon', 'venmo', 'paypal'].map((i) => html`<option>${i}</option>`)}</select> <span class="muted">Date,Amount,Note (+ optional Source, Account, Counterparty, Ref, Items)</span></div>`}</div>
      ${this.preview?.needsMapping ? html`<div class="card"><b>New layout: map the columns once</b><p class="muted">First rows:</p><pre style="overflow:auto">${this.preview.header.join('\n')}</pre>
        <div class="row">${this.colSel('date', 'Date')}${this.colSel('amount', 'Amount')}${this.colSel('description', 'Description')}${this.colSel('postDate', 'Post date')}</div>
        <div class="row" style="margin-top:8px"><label class="muted">Date format <input .value=${this.mapping.dateFormat} @input=${(e: any) => (this.mapping.dateFormat = e.target.value)} /></label><label class="muted"><input type="checkbox" .checked=${this.mapping.signRule === 'invert'} @change=${(e: any) => (this.mapping.signRule = e.target.checked ? 'invert' : 'as_is')} /> charges are positive (invert)</label></div>
        <button class="primary" style="margin-top:8px" @click=${() => this.doPreview()}>Save mapping &amp; preview</button></div>` : ''}
      ${this.preview && !this.preview.needsMapping && !this.preview.notes ? html`<div class="card"><b>Preview</b><div class="row" style="margin-top:6px">
        <span class="badge">${this.preview.total} rows</span><span class="badge">${this.preview.new} new</span><span class="badge">${this.preview.alreadyImported} already imported</span><span class="badge warn">${this.preview.matchesProvisional} match a provisional</span><span class="badge bad">${this.preview.errors.length} errors</span></div>
        ${this.preview.errors.slice(0, 5).map((e: any) => html`<div class="err">line ${e.line}: ${e.error}</div>`)}
        <button class="primary" style="margin-top:8px" ?disabled=${this.preview.new === 0} @click=${() => this.commit()}>Import ${this.preview.new} new${this.files.length > 1 ? ` (first file; ${this.files.length} selected)` : ''}</button></div>` : ''}
      ${this.preview?.notes ? html`<div class="card"><button class="primary" @click=${() => this.commit()}>Import ${this.preview.files} notes file(s) and match</button></div>` : ''}
      ${this.result ? html`<div class="card"><b>Done</b><div class="muted">${Object.entries(this.result).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>${this.result.needsCategory > 20 ? html`<p>Backlog mode: <a href="#/backlog">review them grouped by merchant</a> instead of one by one.</p>` : html`<a href="#/">Answer what needs you →</a>`}</div>` : ''}`;
  }
}
