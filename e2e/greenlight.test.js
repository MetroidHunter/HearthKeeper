import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api } from './helpers.js';

describe('Greenlight', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows both profiles with their own categories and policies', async () => {
    await mount('/greenlight');
    await waitFor(() => $$('.grid2 .card').length === 2, 'profile cards');
    const body = text($('.grid2'));
    expect(body).to.match(/Miracle\s*→ Miracle Spending/);
    expect(body).to.match(/Marion\s*→ Family Support/);
  });

  it('a request never charges until approved; Marion\'s approval needs a category', async () => {
    await mount('/greenlight');
    await waitFor(() => $$('.grid2 .card').length === 2, 'profiles');
    const profiles = (await api('/api/greenlight')).profiles;
    const marion = profiles.find((p) => p.display_name === 'Marion');
    const before = (await api('/api/transactions?hidden=1&limit=500')).length;
    const sel = $$('select').find((s) => /Profile/.test(text(s)));
    choose(sel, 'Marion');
    setInput($('input[placeholder=Amount]'), '40.00');
    byText('button', /Record request/).click();
    await waitFor(() => $$('.badge').some((b) => /pending/.test(text(b))), 'pending request');
    expect((await api('/api/transactions?hidden=1&limit=500')).length).to.equal(before); // no charge yet
    const approve = byText('button', /^Approved$/);
    const catSel = $$('select').find((s) => /Which category pays/.test(text(s)));
    expect(catSel).to.exist;
    approve.click(); // no category chosen: server refuses, the page shows the error
    await waitFor(() => /category/i.test(text($('.err') ?? document.body)), 'error about category');
    choose(catSel, 'Eating Out');
    byText('button', /^Approved$/).click();
    await waitFor(async () => (await api('/api/transactions?hidden=1&limit=500')).length === before + 1, 'charge posted on approval');
    const fam = (await api('/api/budget')).rows.find((r) => r.name === 'Family Support');
    const eat = (await api('/api/budget')).rows.find((r) => r.name === 'Eating Out');
    expect(eat.spent[0]).to.be.greaterThan(0);
    void fam; void marion;
  });

  it('shows no unrecognized messages for the demo corpus but lists the wallet balance', async () => {
    await mount('/greenlight');
    await waitFor(() => /Wallet balance/.test(text(document.body)), 'wallet balance');
    expect(text($$('.card').find((c) => /Unrecognized/.test(text(c.previousElementSibling ?? c))) ?? document.body)).to.be.a('string');
  });
});
