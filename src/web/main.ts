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

const ROUTES: [string, string, () => TemplateResult][] = [
  ['/', 'Home', () => html`<hk-home></hk-home>`],
  ['/dashboard', 'Dashboard', () => html`<hk-dashboard></hk-dashboard>`],
  ['/budget', 'Budget', () => html`<hk-budget></hk-budget>`],
  ['/transactions', 'Transactions', () => html`<hk-transactions></hk-transactions>`],
  ['/plans', 'Plans', () => html`<hk-plans></hk-plans>`],
  ['/earnings', 'Earnings', () => html`<hk-earnings></hk-earnings>`],
  ['/transfers', 'Transfers', () => html`<hk-transfers></hk-transfers>`],
  ['/close', 'Close', () => html`<hk-close></hk-close>`],
  ['/imports', 'Imports', () => html`<hk-imports></hk-imports>`],
  ['/rules', 'Rules & merchants', () => html`<hk-rules></hk-rules>`],
  ['/greenlight', 'Greenlight', () => html`<hk-greenlight></hk-greenlight>`],
  ['/explore', 'Explore', () => html`<hk-explore></hk-explore>`],
  ['/categories', 'Categories', () => html`<hk-categories></hk-categories>`],
  ['/ingest', 'Ingest health', () => html`<hk-ingest></hk-ingest>`],
];

@customElement('hk-app')
export class HkApp extends LitElement {
  @state() private path = this.current();
  createRenderRoot() { return this; }
  private current() { return location.hash.replace(/^#/, '') || '/'; }
  connectedCallback() {
    super.connectedCallback();
    addEventListener('hashchange', () => { this.path = this.current(); });
    flushQueue();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
  render() {
    const base = '/' + (this.path.split('/')[1] ?? '');
    const hit = ROUTES.find(([p]) => p === base) ?? ROUTES[0];
    return html`<nav class="top">${ROUTES.map(([p, label]) => html`<a href="#${p}" class=${p === hit[0] ? 'on' : ''}>${label}</a>`)}</nav>
      <main>${hit[2]()}</main>${nothing}`;
  }
}
