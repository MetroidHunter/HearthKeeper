import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { flushQueue } from './api.js';
import { applyTheme } from './ui.js';
import './pages/home.js';
import './pages/budget.js';
import './pages/transactions.js';
import './pages/plans.js';
import './pages/earnings.js';
import './pages/imports.js';
import './pages/greenlight.js';
import './pages/ingest.js';
import './pages/close.js';
import './pages/rules.js';
import './pages/transfers.js';
import './pages/explore.js';
import './pages/dashboard.js';
import './pages/categories.js';
import './pages/signin.js';
import './pages/settings.js';
import './pages/analytics.js';
import './pages/migration.js';
import './pages/backlog.js';

type Route = { path: string; label: string; hint?: string; view: () => TemplateResult };
const R = (path: string, label: string, view: () => TemplateResult, hint?: string): Route => ({ path, label, view, hint });
const TOP: Route[] = [
  R('/', 'Home', () => html`<hk-home></hk-home>`),
  R('/budget', 'Budget', () => html`<hk-budget></hk-budget>`),
  R('/backlog', 'Backlog', () => html`<hk-backlog></hk-backlog>`),
  R('/transactions', 'Transactions', () => html`<hk-transactions></hk-transactions>`),
];
const MENUS: { label: string; items: Route[] }[] = [
  { label: 'Data', items: [
    R('/categories', 'Categories', () => html`<hk-categories></hk-categories>`, 'Create, retire, unretire, tune'),
    R('/transfers', 'Transfers', () => html`<hk-transfers></hk-transfers>`, 'Move money between envelopes'),
    R('/plans', 'Plans', () => html`<hk-plans></hk-plans>`, 'Draft and go live with a budget'),
    R('/earnings', 'Earnings', () => html`<hk-earnings></hk-earnings>`, 'Income scenarios'),
    R('/imports', 'Imports', () => html`<hk-imports></hk-imports>`, 'Bank CSVs and notes'),
    R('/close', 'Close', () => html`<hk-close></hk-close>`, 'Month-end checklist'),
  ] },
  { label: 'Discover', items: [
    R('/dashboard', 'Dashboard', () => html`<hk-dashboard></hk-dashboard>`, 'The state of the household'),
    R('/analytics', 'Analytics', () => html`<hk-analytics></hk-analytics>`, 'Charts and trends'),
    R('/explore', 'Explore', () => html`<hk-explore></hk-explore>`, 'Slice spending any way'),
  ] },
  { label: 'Settings', items: [
    R('/settings', 'Preferences', () => html`<hk-settings></hk-settings>`, 'Appearance and notifications'),
    R('/greenlight', 'Greenlight', () => html`<hk-greenlight></hk-greenlight>`, 'Kids\' cards and requests'),
    R('/rules', 'Rules & merchants', () => html`<hk-rules></hk-rules>`, 'How things get categorized'),
    R('/ingest', 'Ingest health', () => html`<hk-ingest></hk-ingest>`, 'Is capture working?'),
    R('/migration', 'Migration', () => html`<hk-migration></hk-migration>`, 'Import report and cleanup'),
  ] },
];
const ALL: Route[] = [...TOP, ...MENUS.flatMap((m) => m.items), R('/signin', 'Sign in', () => html`<hk-signin></hk-signin>`)];

@customElement('hk-app')
export class HkApp extends LitElement {
  @state() private path = this.current();
  @state() private auth: { mode: string; user: string | null; googleClientId: string | null } | null = null;
  createRenderRoot() { return this; }
  private current() { return location.hash.replace(/^#/, '') || '/'; }
  private async loadAuth() {
    try { this.auth = await (await fetch('/auth/me', { credentials: 'same-origin' })).json(); } catch { this.auth = { mode: 'dev', user: 'offline', googleClientId: null }; } // offline: show the cached app
  }
  /** Opening one menu closes the others; Escape and any outside click close them all. */
  private oneMenu(opened: HTMLDetailsElement) { this.querySelectorAll('nav details[open]').forEach((d) => { if (d !== opened) d.removeAttribute('open'); }); } // synchronous, so it cannot race the details toggle event
  private closeMenus() { this.querySelectorAll('nav details[open]').forEach((d) => d.removeAttribute('open')); }
  connectedCallback() {
    super.connectedCallback();
    applyTheme();
    document.addEventListener('mousedown', (e) => { if (!(e.target as HTMLElement).closest?.('nav details')) this.closeMenus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeMenus(); });
    this.loadAuth();
    addEventListener('hashchange', () => { this.path = this.current(); });
    addEventListener('hk-unauthorized', () => { this.auth = { mode: 'google', user: null, googleClientId: this.auth?.googleClientId ?? null }; });
    flushQueue();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
  render() {
    if (!this.auth) return html`<p class="muted" style="padding:16px">Loading…</p>`;
    if (this.auth.mode === 'google' && !this.auth.user) return html`<hk-signin .clientId=${this.auth.googleClientId} @signed-in=${() => this.loadAuth()}></hk-signin>`;
    const base = '/' + ((this.path.split('?')[0]).split('/')[1] ?? '');
    const hit = ALL.find((r) => r.path === base) ?? ALL[0];
    const link = (r: Route) => html`<a href="#${r.path}" class=${r.path === hit.path ? 'on' : ''} @click=${() => this.closeMenus()}>${r.label}${r.hint ? html`<small>${r.hint}</small>` : ''}</a>`;
    return html`<nav class="top">${TOP.map(link)}
      ${MENUS.map((m) => html`<details class="menu ${m.items.some((r) => r.path === hit.path) ? 'on' : ''}"><summary @click=${(e: Event) => this.oneMenu((e.currentTarget as HTMLElement).parentElement as HTMLDetailsElement)}>${m.label}</summary><div class="panel">${m.items.map(link)}</div></details>`)}
      ${this.auth.mode === 'google' ? html`<a href="#" class="spacer" @click=${async (e: Event) => { e.preventDefault(); await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'hearthkeeper' }, credentials: 'same-origin' }); navigator.serviceWorker?.controller?.postMessage('logout'); try { localStorage.removeItem('hk-offline-queue'); } catch { /* ignore */ } await this.loadAuth(); }}>Sign out (${this.auth.user})</a>` : ''}</nav>
      <main>${hit.view()}</main>${nothing}`;
  }
}
