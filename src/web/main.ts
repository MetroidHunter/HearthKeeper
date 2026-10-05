import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { flushQueue } from './api.js';
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

const ROUTES: [string, string, () => TemplateResult][] = [
  ['/', 'Home', () => html`<hk-home></hk-home>`],
  ['/dashboard', 'Dashboard', () => html`<hk-dashboard></hk-dashboard>`],
  ['/budget', 'Budget', () => html`<hk-budget></hk-budget>`],
  ['/backlog', 'Backlog', () => html`<hk-backlog></hk-backlog>`],
  ['/transactions', 'Transactions', () => html`<hk-transactions></hk-transactions>`],
  ['/plans', 'Plans', () => html`<hk-plans></hk-plans>`],
  ['/earnings', 'Earnings', () => html`<hk-earnings></hk-earnings>`],
  ['/transfers', 'Transfers', () => html`<hk-transfers></hk-transfers>`],
  ['/close', 'Close', () => html`<hk-close></hk-close>`],
  ['/imports', 'Imports', () => html`<hk-imports></hk-imports>`],
  ['/rules', 'Rules & merchants', () => html`<hk-rules></hk-rules>`],
  ['/greenlight', 'Greenlight', () => html`<hk-greenlight></hk-greenlight>`],
  ['/analytics', 'Analytics', () => html`<hk-analytics></hk-analytics>`],
  ['/explore', 'Explore', () => html`<hk-explore></hk-explore>`],
  ['/categories', 'Categories', () => html`<hk-categories></hk-categories>`],
  ['/migration', 'Migration', () => html`<hk-migration></hk-migration>`],
  ['/ingest', 'Ingest health', () => html`<hk-ingest></hk-ingest>`],
  ['/settings', 'Settings', () => html`<hk-settings></hk-settings>`],
];

@customElement('hk-app')
export class HkApp extends LitElement {
  @state() private path = this.current();
  @state() private auth: { mode: string; user: string | null; googleClientId: string | null } | null = null;
  createRenderRoot() { return this; }
  private current() { return location.hash.replace(/^#/, '') || '/'; }
  private async loadAuth() {
    try { this.auth = await (await fetch('/auth/me', { credentials: 'same-origin' })).json(); } catch { this.auth = { mode: 'dev', user: 'offline', googleClientId: null }; } // offline: show the cached app
  }
  connectedCallback() {
    super.connectedCallback();
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
    const hit = ROUTES.find(([p]) => p === base) ?? ROUTES[0];
    return html`<nav class="top">${ROUTES.map(([p, label]) => html`<a href="#${p}" class=${p === hit[0] ? 'on' : ''}>${label}</a>`)}
      ${this.auth.mode === 'google' ? html`<a href="#" style="margin-left:auto" @click=${async (e: Event) => { e.preventDefault(); await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'hearthkeeper' }, credentials: 'same-origin' }); await this.loadAuth(); }}>Sign out (${this.auth.user})</a>` : ''}</nav>
      <main>${hit[2]()}</main>${nothing}`;
  }
}
