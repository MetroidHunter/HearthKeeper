import { expect } from '@esm-bundle/chai';
export { expect };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() returns truthy (or throw with a useful message). */
export async function waitFor(fn, what = 'condition', timeout = 8000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

export const reset = () => fetch('/__e2e/reset', { method: 'POST', headers: { 'x-requested-with': 'hearthkeeper' } }).then((r) => { if (!r.ok) throw new Error('reset failed'); });
export const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper', ...(opts.headers ?? {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }).then((r) => r.json());

let styled = false;
/** Mount the real app at a hash route, wait for the page element to render something. */
export async function mount(route = '/') {
  if (!styled) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/src/web/styles.css'; document.head.append(l); styled = true; }
  await import('../src/web/main.ts');
  document.body.querySelectorAll('hk-app').forEach((e) => e.remove());
  location.hash = `#${route}`;
  const app = document.createElement('hk-app');
  document.body.append(app);
  await waitFor(() => app.querySelector('main')?.firstElementChild?.querySelector('h1'), `page ${route} to render`);
  return app;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
export const byText = (sel, re, root = document) => $$(sel, root).find((e) => re.test(text(e)));

/** Surface uncaught errors as test failures. */
export function trapErrors() {
  const errs = [];
  const h = (e) => errs.push(e.message ?? String(e.reason ?? e));
  window.addEventListener('error', h); window.addEventListener('unhandledrejection', h);
  return { errs, stop() { window.removeEventListener('error', h); window.removeEventListener('unhandledrejection', h); } };
}

export function setInput(el, value, evt = 'input') { el.value = value; el.dispatchEvent(new Event(evt, { bubbles: true })); }
export function choose(select, optionText) {
  const opt = [...select.options].find((o) => text(o).includes(optionText));
  if (!opt) throw new Error(`no option "${optionText}" in [${[...select.options].map(text).join(', ')}]`);
  select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Searchable category picker: type to filter, click the matching option (the list lives in a popup on <body>). */
export async function pickCat(picker, name) {
  const input = $('input', picker);
  input.focus();
  setInput(input, name);
  const opt = await waitFor(() => $$('.cs-pop .opt').find((o) => text(o).toLowerCase().startsWith(name.toLowerCase())) ?? $$('.cs-pop .opt').find((o) => text(o).toLowerCase().includes(name.toLowerCase())), `category option "${name}"`);
  opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await sleep(30);
}
/** Click the primary button of the open dialog (confirm / save). */
export async function confirmDialog(label = /Yes|Save|Retire|Unretire|Merge|Categorize/) {
  const dlg = await waitFor(() => $$('dialog').find((d) => d.open && $$('button.primary', d).some((b) => label.test(text(b)))), 'an open dialog');
  $$('button.primary', dlg).find((b) => label.test(text(b))).click();
  await sleep(30);
}
