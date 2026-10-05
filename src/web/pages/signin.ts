import { html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { Page } from '../base.js';

declare global { interface Window { google?: any } }

/**
 * Sign in with Google (design §17.4). The server verifies the ID token and checks the email allowlist; nothing sensitive lives in the page.
 * `handleCredential` is what the Google button's callback invokes, and what tests call directly.
 */
@customElement('hk-signin')
export class SignIn extends Page {
  @property() clientId: string | null = null;
  @state() busy = false;
  @state() denied = false;

  async handleCredential(idToken: string) {
    this.busy = true; this.denied = false;
    try {
      const r = await fetch('/auth/google', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, credentials: 'same-origin', body: JSON.stringify({ idToken }) });
      if (!r.ok) { this.denied = true; return; }
      this.dispatchEvent(new CustomEvent('signed-in', { bubbles: true, composed: true }));
    } finally { this.busy = false; }
  }

  firstUpdated() { if (this.clientId) this.loadGoogle(); }

  private loadGoogle() {
    const init = () => {
      window.google?.accounts.id.initialize({ client_id: this.clientId, callback: (resp: { credential: string }) => this.handleCredential(resp.credential), auto_select: false });
      window.google?.accounts.id.renderButton(this.querySelector('#gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with' });
    };
    if (window.google?.accounts) return init();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = init;
    document.head.append(s);
  }

  render() {
    return html`<div style="max-width:420px;margin:12vh auto;padding:0 16px;text-align:center">
      <img src="/icon.svg" width="72" height="72" alt="" />
      <h1>HearthKeeper</h1>
      <p class="muted">Sign in with an allowed Google account.</p>
      ${this.clientId ? html`<div id="gsi-button" style="display:flex;justify-content:center;margin:16px 0"></div>`
        : html`<p class="err">Sign-in is not configured on the server (HK_GOOGLE_CLIENT_ID is missing).</p>`}
      ${this.busy ? html`<p class="muted">Signing in…</p>` : ''}
      ${this.denied ? html`<p class="err" role="alert">That account is not allowed to use this app.</p>` : ''}
    </div>`;
  }
}
