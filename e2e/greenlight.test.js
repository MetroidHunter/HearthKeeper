import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, pickCat, confirmDialog, api } from './helpers.js';

describe('Greenlight is an ordinary payment with a note', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('there is no Greenlight page or menu entry any more; the old address lands on Home', async () => {
    await mount('/greenlight');
    expect(text($('h1'))).to.equal('Home');
    expect($$('nav a').some((a) => /Greenlight/.test(text(a)))).to.equal(false);
  });

  it('funding payments are shown like any other: the child named by the Greenlight message is the note, and that child\'s category is the offered answer', async () => {
    await mount('/backlog');
    const row = await waitFor(() => $$('.trow.txn').find((r) => /GREENLIGHT APP/.test(text(r)) && /\$100\.00/.test(text($('.tamt', r)))), 'the $100 Greenlight payment');
    expect(text($('.tnote', row)), 'the note says which child').to.match(/Marion/);
    expect(row.dataset.cat).to.equal('missing');
    const quick = $('button.quick', row);
    expect(text(quick)).to.equal('Family Support'); expect(quick.title).to.match(/your rule/i);
    const id = Number(row.dataset.id);
    quick.click(); await confirmDialog(/Yes, categorize/);
    await waitFor(async () => (await api(`/api/transactions?q=GREENLIGHT`)).find((t) => t.id === id)?.splits[0]?.category === 'Family Support', 'saved as Family Support');
    const kid = $$('.trow.txn').find((r) => /GREENLIGHT APP/.test(text(r)) && /\$50\.00/.test(text($('.tamt', r))));
    if (kid) expect(text($('button.quick', kid))).to.equal('Miracle Spending');
  });

  it('a live allowance message names the child for a payment already in the system', async () => {
    const chase = (await api('/api/accounts')).find((a) => a.name === 'Wells Fargo Brys').id;
    const made = await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'GREENLIGHT APP 261005 GREENLIGHT BRYS SEPULVEDA', amountCents: -7500, occurredOn: '2026-10-05' } });
    const tok = await api('/api/ingest/tokens', { method: 'POST', body: { label: 'e2e-gl', channel: 'device' } });
    const post = (body) => fetch(`/ingest/device?token=${tok.secret}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    expect((await post('$75.00 allowance transferred to Marion on October 4, 2026 at 09:15AM')).status).to.equal(200);
    await waitFor(async () => (await api('/api/transactions?q=GREENLIGHT')).find((t) => t.id === made.id)?.note === 'Marion', 'the payment carries the child as its note');
    // what the cards themselves do is ignored: no transaction, no page error
    const before = (await api('/api/transactions?hidden=1&limit=500')).length;
    expect((await post('Marion spent $7.07 at WAL-MART #3658 GREENSBORO NC on October 4, 2026 at 09:16AM')).status).to.equal(200);
    expect((await api('/api/transactions?hidden=1&limit=500')).length).to.equal(before);
  });
});
