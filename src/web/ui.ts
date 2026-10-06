import { LitElement, html, nothing, render, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/* ---------- theme (device-level preference: system / light / dark) ---------- */
export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'hk-theme';
export function getTheme(): Theme { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } }
export function applyTheme(t: Theme = getTheme()) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--card').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#1f6f5c');
  window.dispatchEvent(new CustomEvent('hk-theme'));
}
export function setTheme(t: Theme) { try { if (t === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* private mode: still applies for this visit */ } applyTheme(t); }

/* ---------- page furniture ---------- */
/** Title plus a block explaining what the page is for (every page starts with one). */
export const pageHead = (title: string, ...intro: string[]) => html`<div class="pagehead"><h1>${title}</h1><div class="intro">${intro.map((p) => html`<p>${p}</p>`)}</div></div>`;
/** Table header with a hover explanation. */
export const th = (label: string, tip: string, cls = '') => html`<th class=${cls} data-tip=${tip} tabindex="0">${label}</th>`;

/** True when the click landed on the backdrop, not on the dialog's own padding. */
export function clickedBackdrop(d: HTMLDialogElement, e: MouseEvent) {
  if (e.target !== d) return false;
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

/* ---------- dialogs: native <dialog>, shown modally, so they always sit on top of the page ---------- */
/** `dismiss` (default true): a click outside closes it. Dialogs that ask for a decision pass false so a stray click never answers them (Esc still cancels). */
export function showDialog<T = undefined>(body: (close: (v?: T) => void) => TemplateResult, opts: { wide?: boolean; dismiss?: boolean } = {}): Promise<T | undefined> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    if (opts.wide) d.classList.add('wide');
    document.body.append(d);
    let done = false;
    const close = (v?: T) => { if (done) return; done = true; d.close(); resolve(v); };
    d.addEventListener('close', () => { if (!done) { done = true; resolve(undefined); } d.remove(); });
    if (opts.dismiss !== false) d.addEventListener('click', (e) => { if (clickedBackdrop(d, e)) close(undefined); });
    render(body(close), d);
    d.showModal();
  });
}
export function confirmBox(o: { title: string; body: TemplateResult | string; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return showDialog<boolean>((close) => html`<h3 class="title">${o.title}</h3><div>${o.body}</div>
    <div class="actions"><button class="cancel" @click=${() => close(false)}>${o.cancel ?? 'Cancel'}</button><button class=${o.danger ? 'primary danger-solid confirm' : 'primary confirm'} autofocus @click=${() => close(true)}>${o.confirm ?? 'Yes'}</button></div>`, { dismiss: false }).then((v) => v === true);
}
export function promptBox(o: { title: string; label?: string; value?: string; confirm?: string }): Promise<string | undefined> {
  return showDialog<string>((close) => {
    let v = o.value ?? '';
    return html`<h3 class="title">${o.title}</h3><label class="stack">${o.label ?? ''}<input .value=${v} @input=${(e: any) => (v = e.target.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && close(v)} /></label>
      <div class="actions"><button @click=${() => close(undefined)}>Cancel</button><button class="primary" @click=${() => close(v)}>${o.confirm ?? 'OK'}</button></div>`;
  }, { dismiss: false });
}

/* ---------- searchable category dropdown ---------- */
export interface PickCat { id: number; name: string; group_name?: string | null; status?: string; kind?: string; system?: number }

/**
 * Type to filter, arrow keys + Enter or click to choose. Replaces every category <select> in the app.
 * Emits `change` with detail { id, name } (id null when cleared). Only the open list is rendered, so it stays cheap with many instances on a page.
 */
@customElement('hk-category-select')
export class CategorySelect extends LitElement {
  @property({ attribute: false }) cats: PickCat[] = [];
  @property({ type: Number }) value: number | null = null;
  @property() placeholder = 'Category';
  @property({ type: Boolean }) includeRetired = false;
  @property({ type: Boolean }) clearable = false;
  @property() clearLabel = '';
  @state() private open = false; @state() private q = ''; @state() private idx = 0;
  private pop: HTMLElement | null = null;
  createRenderRoot() { return this; }
  private get chosen() { return this.cats.find((c) => c.id === this.value) ?? null; }
  private options(): PickCat[] {
    const q = this.q.trim().toLowerCase(); const parts = q.split(/\s+/).filter(Boolean);
    return this.cats.filter((c) => !c.system && (c.status === undefined || c.status === 'active' || this.includeRetired) && (!parts.length || parts.every((p) => `${c.name} ${c.group_name ?? ''}`.toLowerCase().includes(p))))
      .sort((a, b) => (a.group_name ?? 'Other').localeCompare(b.group_name ?? 'Other') || a.name.localeCompare(b.name));
  }
  private choose(c: PickCat | null) {
    this.value = c?.id ?? null; this.open = false; this.q = '';
    this.dispatchEvent(new CustomEvent('change', { detail: { id: c?.id ?? null, name: c?.name ?? '' }, bubbles: true }));
  }
  private place() {
    const input = this.querySelector('input'); const pop = this.pop; if (!input || !pop) return;
    const r = input.getBoundingClientRect(); const below = window.innerHeight - r.bottom, above = r.top; const h = Math.min(280, pop.scrollHeight + 8);
    pop.style.left = `${r.left}px`; pop.style.width = `${Math.max(r.width, 240)}px`;
    if (below < h && above > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; } else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; }
  }
  private onDocDown = (e: Event) => { if (!this.contains(e.target as Node) && !this.pop?.contains(e.target as Node)) { this.open = false; this.q = ''; } };
  private onScroll = (e: Event) => { if (this.open && !this.pop?.contains(e.target as Node)) this.place(); };
  connectedCallback() { super.connectedCallback(); document.addEventListener('mousedown', this.onDocDown); addEventListener('scroll', this.onScroll, true); addEventListener('resize', this.onScroll); }
  disconnectedCallback() { super.disconnectedCallback(); document.removeEventListener('mousedown', this.onDocDown); removeEventListener('scroll', this.onScroll, true); removeEventListener('resize', this.onScroll); this.pop?.remove(); }
  private key(e: KeyboardEvent) {
    const opts = this.options();
    if (e.key === 'ArrowDown') { e.preventDefault(); this.open = true; this.idx = Math.min(opts.length - 1, this.idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.idx = Math.max(0, this.idx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (this.open && opts[this.idx]) this.choose(opts[this.idx]); else this.open = true; }
    else if (e.key === 'Escape') { this.open = false; this.q = ''; (e.target as HTMLElement).blur(); }
  }
  updated() {
    // The list lives in a fixed-position popup outside any clipping dialog/table container.
    if (this.open) {
      // Inside a modal dialog the list must live in the dialog: only top-layer content can sit above a modal.
      if (!this.pop) { this.pop = document.createElement('div'); this.pop.className = 'cs-pop'; this.pop.setAttribute('role', 'listbox'); (this.closest('dialog') ?? document.body).append(this.pop); }
      const opts = this.options(); let lastGroup = '';
      render(opts.length ? html`${opts.map((c, i) => { const g = c.group_name ?? 'Other'; const head = g !== lastGroup ? html`<div class="grp">${(lastGroup = g)}</div>` : nothing;
        return html`${head}<div class="opt ${i === this.idx ? 'active' : ''} ${c.status === 'retired' ? 'retired' : ''}" role="option" data-id=${c.id} @mousedown=${(e: Event) => { e.preventDefault(); this.choose(c); }} @mousemove=${() => { if (this.idx !== i) { this.idx = i; } }}>${c.name}${c.status === 'retired' ? ' (retired)' : ''}</div>`; })}` : html`<div class="none">No category matches “${this.q}”.</div>`, this.pop);
      this.place(); this.pop.querySelector('.opt.active')?.scrollIntoView({ block: 'nearest' });
    } else if (this.pop) { this.pop.remove(); this.pop = null; }
  }
  render() {
    const shown = this.open ? this.q : this.chosen?.name ?? '';
    return html`<input type="text" role="combobox" aria-expanded=${this.open} autocomplete="off" spellcheck="false" placeholder=${this.chosen ? '' : this.placeholder} .value=${shown}
      @focus=${(e: any) => { this.open = true; this.idx = 0; e.target.select?.(); }} @input=${(e: any) => { this.q = e.target.value; this.open = true; this.idx = 0; }} @keydown=${(e: KeyboardEvent) => this.key(e)}
      @blur=${() => setTimeout(() => { if (!this.contains(document.activeElement)) { this.open = false; this.q = ''; } }, 120)} />`;
  }
}
declare global { interface HTMLElementTagNameMap { 'hk-category-select': CategorySelect } }

/** Template helper: <hk-category-select> wired to a callback. */
export const catSelect = (cats: PickCat[], value: number | null | undefined, onPick: (id: number | null, name: string) => void, o: { placeholder?: string; includeRetired?: boolean } = {}) =>
  html`<hk-category-select .cats=${cats} .value=${value ?? null} placeholder=${o.placeholder ?? 'Category'} ?includeRetired=${o.includeRetired} @change=${(e: CustomEvent) => onPick(e.detail.id, e.detail.name)}></hk-category-select>`;
