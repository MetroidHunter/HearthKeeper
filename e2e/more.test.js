import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api, sleep } from './helpers.js';

describe('Navigation smoke: every page renders without uncaught errors', () => {
  let trap;
  before(async () => { await reset(); });
  beforeEach(() => { trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  for (const [route, h1] of [['/', 'Home'], ['/dashboard', 'Dashboard'], ['/budget', 'Budget'], ['/transactions', 'Transactions'], ['/plans', 'Plans'], ['/earnings', 'Earnings'], ['/transfers', 'Transfers'],
    ['/close', 'Close the month'], ['/imports', 'Imports'], ['/rules', 'Rules & merchants'], ['/greenlight', 'Greenlight'], ['/explore', 'Explore'], ['/categories', 'Categories'], ['/ingest', 'Ingest health'], ['/settings', 'Settings'], ['/analytics', 'Analytics'], ['/migration', 'Migration']]) {
    it(`renders ${route}`, async () => { await mount(route); expect(text($('h1'))).to.equal(h1); await sleep(150); });
  }
});

describe('Rules and merchants', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('backtests a new rule before saving it, and the saved rule suggests next time', async () => {
    await mount('/rules');
    await waitFor(() => $$('tbody tr').length > 3, 'rules');
    byText('button', /New rule/).click();
    const card = await waitFor(() => $$('.card').find((c) => /Backtest/.test(text(c))), 'rule editor');
    setInput($$('input', card).find((i) => i.placeholder === 'value'), 'chipotle');
    choose($$('select', card)[2], 'Eating Out');
    byText('button', /^Backtest$/, card).click();
    await waitFor(() => /Would have matched/.test(text(card)), 'backtest result');
    expect(text(card)).to.match(/matched \d+/);
    byText('button', /^Save$/, card).click();
    await waitFor(async () => (await api('/api/rules')).some((r) => /chipotle/i.test(r.match_json) && r.mode === 'suggest'), 'rule saved in suggest mode (verbose by default)');
  });

  it('merchants to review shows unreviewed merchants', async () => {
    await mount('/rules');
    byText('button', /Merchants to review/).click();
    await waitFor(() => $$('tbody tr').length > 3 && /new/.test(text($('tbody'))), 'merchant rows');
  });
});

describe('Close checklist and dashboard', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('lists every step and blocks closing while items are open', async () => {
    await mount('/close');
    await waitFor(() => $$('.card .row').length >= 11, 'steps');
    expect(text($('.card'))).to.match(/Uncategorized/);
    const close = byText('button', /Resolve items to close|Close period/);
    expect(close.disabled).to.equal(true);
  });
  it('dashboard shows close readiness and coverage', async () => {
    await mount('/dashboard');
    await waitFor(() => /Close readiness/.test(text(document.body)) && /Coverage/.test(text(document.body)), 'dashboard cards');
  });
});

describe('Earnings', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('computes net monthly and bi-weekly live from gross, work time and tax (the Projection arithmetic)', async () => {
    await mount('/earnings');
    byText('button', /New scenario/).click();
    const card = await waitFor(() => $$('.card').find((c) => /recurring/.test(text(c))), 'editor');
    const [, , , gross, work, tax] = $$('input', card);
    setInput(gross, '220000'); setInput(tax, '32');
    await waitFor(() => /\$12,466\.67\/mo/.test(text(card)), 'live net monthly');
    expect(text(card)).to.match(/\$5,753\.85 bi-weekly/);
    setInput(work, '92');
    await waitFor(() => /\$11,469\.33\/mo/.test(text(card)), 'work time applied');
  });
});

describe('Transfers: rebalance', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('proposes pool-first rebalance for an overspent envelope, then commits balanced legs', async () => {
    const cats = await api('/api/categories');
    const id = (n) => cats.find((c) => c.name === n).id;
    const accts = await api('/api/accounts');
    const chase = accts.find((a) => a.name === 'Chase Prime Visa').id, wf = accts.find((a) => /Wells Fargo Brys/.test(a.name)).id;
    // overspend Pets, and earn Gig Income so the pool can pay first
    await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'VET BILL', amountCents: -2_000_000, categoryId: id('Pets') } });
    await api('/api/transactions', { method: 'POST', body: { accountId: wf, descriptor: 'GIG PAYMENT', amountCents: 300_000, categoryId: id('Gig Income') } });
    await mount('/transfers');
    byText('button', /^Propose$/).click();
    await waitFor(() => /Resulting balances/.test(text(document.body)), 'proposal');
    expect(text(document.body)).to.match(/Pool Gig Income → Pets/);
    byText('button', /^Commit$/).click();
    await waitFor(async () => (await api('/api/transfers')).some((t) => t.kind === 'pool_payment'), 'pool payment recorded');
    const legs = (await api('/api/transfers')).filter((t) => t.kind === 'pool_payment' || t.kind === 'reconcile');
    for (const t of legs) expect(JSON.parse(t.legs).reduce((a, l) => a + l.cents, 0)).to.equal(0);
  });
});

describe('Categories', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('adds a category with a start month and first budget version, and shows its history', async () => {
    await mount('/categories');
    await waitFor(() => $$('tbody tr').length > 5, 'categories');
    const form = $$('.card').find((c) => /Add category/.test(text(c)));
    const [name, group, , monthly] = $$('input', form);
    setInput(name, 'E2E Hobby'); setInput(group, 'Fun'); setInput(monthly, '75');
    await waitFor(() => !byText('button', /^Add$/, form).disabled, 'Add to enable once a name is typed');
    byText('button', /^Add$/, form).click();
    await waitFor(() => $$('tbody tr').some((r) => /E2E Hobby/.test(text(r))), 'new row');
    const id = (await api('/api/categories')).find((c) => c.name === 'E2E Hobby').id;
    location.hash = `#/categories/${id}`;
    await waitFor(() => /Budget history/.test(text(document.body)) && /\$75\.00/.test(text(document.body)), 'history timeline');
  });
});

describe('Settings: notifications', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows verbose defaults, saves quiet hours / digest hour / privacy, and previews the digest', async () => {
    await mount('/settings');
    await waitFor(() => $('#push'), 'prefs');
    expect($('#push').checked).to.equal(true);
    expect($('#quiet').checked).to.equal(false);   // verbose first: quiet hours off by default
    expect($('#privacy').checked).to.equal(false);
    $('#quiet').click(); await waitFor(async () => (await api('/api/me/notify-prefs')).quiet.enabled === true, 'quiet saved');
    setInput($('#digest-hour'), '9', 'change'); await waitFor(async () => (await api('/api/me/notify-prefs')).digestHour === 9, 'digest hour saved');
    $('#privacy').click(); await waitFor(async () => (await api('/api/me/notify-prefs')).lockScreenPrivacy === true, 'privacy saved');
    expect(text(document.body)).to.match(/need you/); // digest preview
    const q = (await api('/api/me/notify-prefs')).quiet;
    expect(q.start).to.equal('22:00');
  });
});

describe('Migration worksheet', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('resolves parked leftovers with one tap per suggestion and shows the before/after balance of every category touched', async () => {
    await mount('/migration');
    await waitFor(() => $$('tbody tr').length === 3, 'three parked rows');
    const before = await api('/api/migration');
    byText('button', /Accept top suggestions/).click();
    await waitFor(() => !$('#apply').disabled, 'apply enabled');
    $('#apply').click();
    await waitFor(() => /Applied \d/.test(text(document.body)), 'result card');
    expect(text(document.body)).to.match(/Gig Income/); expect(text(document.body)).to.match(/Pets/);
    const after = await api('/api/migration');
    expect(after.worksheet.length).to.be.lessThan(before.worksheet.length);
    // the Gig Income balance moved by exactly the Zelle amount
    const gig = $$('table tbody tr').find((r) => /^Gig Income/.test(text(r)));
    expect(text(gig)).to.match(/\+\$300\.00/);
  });
});
