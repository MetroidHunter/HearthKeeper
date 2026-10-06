import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api, fmtDate } from '../api.js';
import { pageHead, getTheme, setTheme, confirmBox, toast, type Theme } from '../ui.js';

function b64ToUint8(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** "Chrome on Android" from a user-agent string: enough to tell your devices apart. */
export function deviceName(ua?: string | null) {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br}${os ? ` on ${os}` : ''}`;
}

/** Notifications settings (design §15.3): verbose by default; quiet hours and lock-screen privacy off until you want them. */
@customElement('hk-settings')
export class Settings extends Page {
  @state() prefs: any = null; @state() digest: any = null; @state() status = ''; @state() theme: Theme = getTheme(); @state() devices: any[] = []; @state() thisEndpoint: string | null = null; @state() canPush = true;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.prefs, this.digest, this.devices] = await Promise.all([api.get('/api/me/notify-prefs'), api.get('/api/digest'), api.get('/api/push/devices')]); }); this.thisEndpoint = (await this.thisSub())?.endpoint ?? null; }
  /** This browser's own push subscription, if it has one. Never waits forever: a browser with no service worker answers null. */
  private async thisSub(): Promise<PushSubscription | null> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { this.canPush = false; return null; }
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no service worker')), 2500))]);
      return await reg.pushManager.getSubscription();
    } catch { return null; }
  }
  private get thisDevice() { return this.devices.find((d) => d.endpoint === this.thisEndpoint) ?? null; }
  async disableHere() {
    await this.run(async () => {
      const sub = await this.thisSub();
      if (sub) { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      this.status = 'Notifications are off for this device.'; toast('Notifications off for this device');
    });
    await this.load();
  }
  async removeDevice(d: any) {
    const here = d.endpoint === this.thisEndpoint;
    if (!(await confirmBox({ title: `Stop notifications to ${deviceName(d.user_agent)}?`, body: html`<p>${here ? 'This is the device you are using. ' : ''}It will stop receiving prompts and the daily digest. You can add it back any time by turning notifications on from that device.</p>`, confirm: 'Remove device', danger: true }))) return;
    await this.run(async () => { await api.del(`/api/push/devices/${d.id}`); if (here) { const sub = await this.thisSub(); await sub?.unsubscribe(); } toast('Device removed'); });
    await this.load();
  }
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
      this.status = 'Notifications are on for this device.'; toast('Notifications on for this device'); await this.load();
    });
  }
  render() {
    const p = this.prefs; if (!p) return html`${pageHead('Preferences', 'How HearthKeeper looks on this device, and when and how it notifies you.', 'Appearance is remembered on this device only, so your phone and your computer can differ. Notification settings are yours; Miracle sets her own when she signs in.')}<p class="muted">${this.err || 'Loading…'}</p>`;
    return html`${pageHead('Preferences', 'How HearthKeeper looks on this device, and when and how it notifies you.', 'Appearance is remembered on this device only, so your phone and your computer can differ. Notification settings are yours; Miracle sets her own when she signs in.')}${this.err ? html`<p class="err">${this.err}</p>` : ''}
      <h2>Appearance</h2>
      <div class="card"><div class="option-list" role="radiogroup" aria-label="Theme">${([['system', 'Match this device', 'Follows your phone or computer setting, including automatic night mode.'], ['light', 'Light', 'Always light.'], ['dark', 'Dark', 'Always dark.']] as [Theme, string, string][]).map(([v, label, hint]) => html`
        <button class="option ${this.theme === v ? 'best' : ''}" role="radio" aria-checked=${this.theme === v} data-theme-choice=${v} @click=${() => { this.theme = v; setTheme(v); }}><span class="name">${label}</span><span class="muted small">${hint}</span>${this.theme === v ? html`<span class="meta">✓ selected</span>` : ''}</button>`)}</div></div>
      <h2>Notifications</h2>
      ${p.push === false ? html`<div class="card row"><span class="grow"><b>Notifications are paused for you</b> (an older setting): none of your devices are being notified.</span><button class="primary" id="resume" @click=${() => this.save({ push: true })}>Turn notifications back on</button></div>` : nothing}
      <div class="card">
        <h3>Devices that get your notifications</h3>
        ${this.devices.length === 0 ? html`<p class="muted" style="margin:8px 0 0">No devices yet. Turn notifications on from the phone or computer you want them on.</p>` : html`<div class="list" id="devices" style="margin-top:8px">${this.devices.map((d) => html`<div class="list-row device" data-id=${d.id}>
          <div class="grow"><b>${deviceName(d.user_agent)}</b> ${d.endpoint === this.thisEndpoint ? html`<span class="badge good">This device</span>` : nothing}
            <div class="muted small">Added ${fmtDate(String(d.created_at).slice(0, 10))}${d.last_ok_at ? ` · last delivered ${fmtDate(String(d.last_ok_at).slice(0, 10))}` : ' · nothing delivered yet'}</div></div>
          <button class="remove danger" @click=${() => this.removeDevice(d)}>Remove</button></div>`)}</div>`}
        <div class="row" style="margin-top:12px">
          ${!this.canPush ? html`<span class="muted small">This browser cannot receive notifications. On an iPhone, add HearthKeeper to the home screen first and open it from there.</span>`
            : this.thisDevice ? html`<button id="disable" @click=${() => this.disableHere()}>Turn off notifications on this device</button>`
            : html`<button class="primary" id="enable" @click=${() => this.enablePush()}>Turn on notifications on this device</button>`}
          <button id="test" ?disabled=${this.devices.length === 0} @click=${async () => { await this.run(async () => { const r = await api.post('/api/push/test'); this.status = `Test sent to ${r.results.length} device${r.results.length === 1 ? '' : 's'}: ${r.results.map((x: any) => x.status).join(', ')}`; }); }}>Send a test to my devices</button></div>
        <p class="muted small" style="margin-bottom:0">Each device is on or off by itself; there is no separate master switch. Prompts are real-time for Chase purchases and Greenlight; everything else waits for the morning digest. The first of you to answer closes the prompt on the other phone.</p>
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
