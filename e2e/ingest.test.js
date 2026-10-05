import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api } from './helpers.js';

describe('Ingest health and the Shapes page', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('clusters raw events by template and lets you mark noise', async () => {
    await mount('/ingest');
    await waitFor(() => $$('.card').length > 3, 'clusters');
    const chase = $$('.card').find((c) => /chase_alert/.test(text(c)));
    expect(chase).to.exist;
    expect(text(chase)).to.match(/unparsed/); // the demo's chase alert text does not match the real shape, so it stays unrecognized
    byText('button', /Noise/, chase).click();
    await waitFor(async () => (await api('/api/shapes')).some((s) => s.source === 'chase_alert' && s.decision === 'noise'), 'decision saved');
  });

  it('health tab lists sources and tokens', async () => {
    await mount('/ingest');
    byText('button', /Sources & tokens/).click();
    await waitFor(() => /greenlight_msg/.test(text(document.body)) && /greenlight-device/.test(text(document.body)), 'health tables');
  });

  it('live capture: a webhook post appears as a new transaction after replay', async () => {
    const tok = await api('/api/ingest/tokens', { method: 'POST', body: { label: 'e2e', channel: 'device' } });
    const r = await fetch(`/ingest/device?token=${tok.secret}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '$25.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM' });
    expect(r.status).to.equal(200);
    const j = await r.json();
    expect(j.duplicate).to.equal(false);
    const again = await (await fetch(`/ingest/device?token=${tok.secret}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '$25.00 allowance transferred to Miracle on October 3, 2026 at 09:15AM' })).json();
    expect(again.duplicate).to.equal(true);
    expect((await api('/api/transactions?hidden=1&q=ALLOWANCE')).some((t) => t.amount_cents === -2500)).to.equal(true);
  });
});
