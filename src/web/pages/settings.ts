import { html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { pageHead, getTheme, setTheme, type Theme } from '../ui.js';

function b64ToUint8(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Notifications settings (design §15.3): verbose by default; quiet hours and lock-screen privacy off until you want them. */
@customElement('hk-settings')
export class Settings extends Page {
  @state() prefs: any = null; @state() digest: any = null; @state() status = ''; @state() theme: Theme = getTheme();
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.prefs, this.digest] = await Promise.all([api.get('/api/me/notify-prefs'), api.get('/api/digest')]); }); }
  async save(patch: any) { await this.run(async () => { this.prefs = { ...this.prefs, ...(await api.put('/api/me/notify-prefs', patch)) }; this.status = 'Saved'; }); }
  async enablePush() {
    await this.run(async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) { this.status = 'This browser does not support push notifications.'; return; }
      if ((await Notification.requestPermission()) !== 'granted') { this.status = 'Notifications were not allowed.'; return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.get('/api/push/public-key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
      const j = sub.toJSON();
      await api.post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys });
      this.status = 'Notifications are on for this device.'; await this.load();
    });
  }
  render() {
    const p = this.prefs; if (!p) return html`${pageHead('Preferences', 'How HearthKeeper looks and when it bothers you.')}<p class="muted">${this.err || 'Loading…'}</p>`;
    return html`${pageHead('Preferences', 'How HearthKeeper looks on this device, and when and how it notifies you.', 'Appearance is remembered on this device only, so your phone and your computer can differ. Notification settings are yours; Miracle sets her own when she signs in.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <h2>Appearance</h2>
      <div class="card"><div class="option-list" role="radiogroup" aria-label="Theme">${([['system', 'Match this device', 'Follows your phone or computer setting, including automatic night mode.'], ['light', 'Light', 'Always light.'], ['dark', 'Dark', 'Always dark.']] as [Theme, string, string][]).map(([v, label, hint]) => html`
        <button class="option ${this.theme === v ? 'best' : ''}" role="radio" aria-checked=${this.theme === v} data-theme-choice=${v} @click=${() => { this.theme = v; setTheme(v); }}><span class="name">${label}</span><span class="muted small">${hint}</span>${this.theme === v ? html`<span class="meta">✓ selected</span>` : ''}</button>`)}</div></div>
      <h2>Notifications</h2>
      <div class="card">
        <div class="row"><label class="grow"><input type="checkbox" id="push" .checked=${p.push} @change=${(e: any) => this.save({ push: e.target.checked })} /> Send push notifications to me</label><span class="badge">${p.devices} device${p.devices === 1 ? '' : 's'}</span></div>
        <div class="row" style="margin-top:8px"><button class="primary" id="enable" @click=${() => this.enablePush()}>Enable on this device</button><button id="test" @click=${async () => { await this.run(async () => { const r = await api.post('/api/push/test'); this.status = `Test sent: ${r.results.map((x: any) => x.status).join(', ')}`; }); }}>Send a test</button></div>
        <p class="muted">Prompts are real-time for Chase purchases and Greenlight; everything else waits for the morning digest. The first of you to answer closes the prompt on the other phone.</p>
      </div>
      <div class="card">
        <div class="row"><label><input type="checkbox" id="quiet" .checked=${p.quiet.enabled} @change=${(e: any) => this.save({ quiet: { enabled: e.target.checked } })} /> Quiet hours</label>
          <input type="time" id="quiet-start" .value=${p.quiet.start} @change=${(e: any) => this.save({ quiet: { start: e.target.value } })} /> to <input type="time" id="quiet-end" .value=${p.quiet.end} @change=${(e: any) => this.save({ quiet: { end: e.target.value } })} /></div>
        <div class="row" style="margin-top:8px"><label>Morning digest at <input type="number" id="digest-hour" min="0" max="23" style="width:4rem" .value=${String(p.digestHour)} @change=${(e: any) => this.save({ digestHour: Number(e.target.value) })} />:00</label></div>
        <div class="row" style="margin-top:8px"><label><input type="checkbox" id="privacy" .checked=${p.lockScreenPrivacy} @change=${(e: any) => this.save({ lockScreenPrivacy: e.target.checked })} /> Hide merchant and amount on the lock screen</label></div>
      </div>
      ${this.status ? html`<p class="muted" role="status">${this.status}</p>` : ''}
      <h2>Today's digest preview</h2>
      <div class="card"><b>${this.digest?.text}</b>
        ${this.digest?.autoCategorized.length ? html`<h2>Auto-categorized in the last day</h2>${this.digest.autoCategorized.slice(0, 12).map((a: any) => html`<div class="row"><span class="grow">${a.descriptor}</span><span class="muted">${a.category ?? ''}</span></div>`)}` : ''}</div>`;
  }
}
