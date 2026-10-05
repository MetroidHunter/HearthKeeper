import { expect, reset, waitFor, $, $$, text, byText, trapErrors, api, sleep } from './helpers.js';

async function mountApp(route = '/') {
  await import('../src/web/main.ts');
  document.body.querySelectorAll('hk-app').forEach((e) => e.remove());
  location.hash = `#${route}`;
  const app = document.createElement('hk-app');
  document.body.append(app);
  return app;
}
const setMode = (mode) => fetch('/__e2e/auth-mode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify({ mode }) });

describe('Sign-in (Google OIDC allowlist, with a fake token verifier)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'hearthkeeper' } }); });
  afterEach(async () => { trap.stop(); await reset(); });

  it('anonymous users see the sign-in page, not the app; the API refuses them', async () => {
    await setMode('google');
    const app = await mountApp('/budget');
    await waitFor(() => $('hk-signin', app), 'sign-in page');
    expect(text(app)).to.match(/Sign in with an allowed Google account/);
    expect($('nav.top', app)).to.equal(null);
    expect((await fetch('/api/budget')).status).to.equal(401);
  });

  it('an allowlisted Google user signs in, gets a session cookie, sees the app, and can sign out', async () => {
    await setMode('google');
    const app = await mountApp('/budget');
    const signin = await waitFor(() => $('hk-signin', app), 'sign-in page');
    await signin.handleCredential('good-token'); // what the Google button's callback does
    await waitFor(() => $('nav.top', app) && $('h1', app), 'app after sign-in');
    expect(text(app)).to.match(/Sign out \(me@example\.com\)/);
    expect((await fetch('/api/budget')).status).to.equal(200);
    byText('a', /Sign out/, app).click();
    await waitFor(() => $('hk-signin', app), 'back to sign-in after sign out');
    expect((await fetch('/api/budget')).status).to.equal(401);
  });

  it('a valid Google account that is not on the allowlist is refused', async () => {
    await setMode('google');
    const app = await mountApp('/');
    const signin = await waitFor(() => $('hk-signin', app), 'sign-in page');
    await signin.handleCredential('stranger-token');
    await waitFor(() => /not allowed/.test(text(app)), 'denial message');
    expect((await fetch('/api/budget')).status).to.equal(401);
    await signin.handleCredential('forged-token');
    expect((await fetch('/api/budget')).status).to.equal(401);
  });

  it('mutations need the CSRF header even when signed in', async () => {
    await setMode('google');
    const app = await mountApp('/');
    const signin = await waitFor(() => $('hk-signin', app), 'sign-in page');
    await signin.handleCredential('good-token');
    await waitFor(() => $('nav.top', app), 'app');
    const noHeader = await fetch('/api/rules/backtest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ match: { all_of: [] } }) });
    expect(noHeader.status).to.equal(403);
  });
});
