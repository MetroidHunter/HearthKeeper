import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, pickCat, confirmDialog, api, sleep } from './helpers.js';

describe('Navigation smoke: every page renders without uncaught errors', () => {
  let trap;
  before(async () => { await reset(); });
  beforeEach(() => { trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  for (const [route, h1] of [['/', 'Home'], ['/dashboard', 'Dashboard'], ['/budget', 'Budget'], ['/transactions', 'Transactions'], ['/plans', 'Plans'], ['/earnings', 'Earnings'], ['/transfers', 'Transfers'],
    ['/close', 'Close the month'], ['/imports', 'Imports'], ['/rules', 'Rules & merchants'], ['/greenlight', 'Greenlight'], ['/explore', 'Explore'], ['/categories', 'Categories'], ['/ingest', 'Ingest health'], ['/settings', 'Preferences'], ['/analytics', 'Analytics'], ['/migration', 'Migration'], ['/backlog', 'Backlog']]) {
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
    await pickCat($('hk-category-select', card), 'Eating Out');
    byText('button', /^Backtest$/, card).click();
    await waitFor(() => /Would have matched/.test(text(card)), 'backtest result');
    expect(text(card)).to.match(/matched \d+/);
    byText('button', /^Save$/, card).click();
    await waitFor(async () => (await api('/api/rules')).some((r) => /chipotle/i.test(r.match_json) && r.mode === 'suggest'), 'rule saved in suggest mode (verbose by default)');
  });

  it('merchants to review shows unreviewed merchants', async () => {
    await mount('/rules');
    byText('button', /^Merchants/).click();
    await waitFor(() => $$('tbody tr').length > 3 && /new/.test(text($('tbody'))), 'merchant rows');
    expect($$('tbody tr').length).to.be.at.most(50); // paged: never the whole merchant list
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
    await waitFor(() => /Close readiness/.test(text(document.body)) && /Health/.test(text(document.body)), 'dashboard callouts');
    await waitFor(() => $$('.chart canvas').length >= 2, 'diagrams drawn');
    expect($$('a.stat').length).to.be.greaterThan(4); // callouts are links to where you act on them
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

describe('Earnings: typing into number fields', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  /** Type one character at a time like a person, the way the browser reports it: the value so far, then an input event. */
  const typeInto = async (el, str) => { el.focus(); el.value = ''; for (const ch of str) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(15); } };
  it('typing keeps what you typed (no reformatting under the cursor) and tidies the number when you leave the box', async () => {
    await mount('/earnings');
    byText('button', /New scenario/).click();
    const card = await waitFor(() => $$('.card').find((c) => /recurring/.test(text(c))), 'editor');
    const gross = $('input.gross', card), tax = $('input.tax', card), work = $('input.work', card);
    await typeInto(gross, '220000');
    expect(gross.value).to.equal('220000'); // not "2200.00" / cents
    await typeInto(tax, '32.5');
    expect(tax.value).to.equal('32.5'); // the dot survives
    await typeInto(work, '92.5');
    expect(work.value).to.equal('92.5');
    await waitFor(() => /\$11,|\$12,/.test(text(card)), 'live net recalculated');
    gross.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => gross.value === '220000.00', 'tidied on blur');
    byText('button', /^Save$/, card).click();
    await waitFor(async () => (await api('/api/scenarios')).some((s) => s.lines.some((l) => l.annualSalaryCents === 22000000 && l.taxRateBp === 3250 && l.workTimeBp === 9250)), 'saved with the exact numbers typed');
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
    await waitFor(() => $$('.card.ws').length === 3, 'three parked rows');
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

describe('Backlog review (grouped by merchant)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('one answer categorizes every transaction of a merchant and teaches a suggest-mode rule', async () => {
    const accts = await api('/api/accounts'); const chase = accts.find((a) => a.name === 'Chase Prime Visa').id;
    for (let i = 0; i < 4; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'BRAND NEW BAKERY', amountCents: -(500 + i) } });
    await mount('/backlog');
    const card = await waitFor(() => $$('.group').find((c) => /BRAND NEW BAKERY/.test(text(c))), 'merchant group');
    expect(text(card)).to.match(/4 transactions/);
    expect($$('.txn-line', card).length).to.be.greaterThan(0); // full lines are shown
    await pickCat($('hk-category-select', card), 'Eating Out');
    await confirmDialog(/Yes, categorize/);
    await waitFor(() => /4 categorized/.test(text(document.body)), 'bulk result');
    const tx = await api('/api/transactions?q=BRAND%20NEW%20BAKERY');
    expect(tx).to.have.length(4); expect(tx.every((t) => t.splits[0]?.category === 'Eating Out')).to.equal(true);
    expect((await api('/api/rules')).some((r) => /BRAND NEW BAKERY/i.test(r.match_json) && r.mode === 'suggest')).to.equal(true);
  });
});
