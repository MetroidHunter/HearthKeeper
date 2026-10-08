import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, pickCat, confirmDialog, api, sleep } from './helpers.js';

describe('Navigation smoke: every page renders without uncaught errors', () => {
  let trap;
  before(async () => { await reset(); });
  beforeEach(() => { trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  for (const [route, h1] of [['/', 'Home'], ['/dashboard', 'Dashboard'], ['/budget', 'Budget'], ['/transactions', 'Transactions'], ['/plans', 'Plans'], ['/earnings', 'Earnings'], ['/transfers', 'Transfers'],
    ['/months', 'Months'], ['/imports', 'Imports'], ['/rules', 'Rules & merchants'], ['/explore', 'Explore'], ['/categories', 'Categories'], ['/ingest', 'Ingest health'], ['/settings', 'Preferences'], ['/analytics', 'Analytics'], ['/migration', 'Migration'], ['/backlog', 'Backlog']]) {
    it(`renders ${route}`, async () => { await mount(route); expect(text($('h1'))).to.equal(h1); await sleep(150); });
  }
});

describe('Rules and merchants', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  const mrows = () => $$('.mlist .mrow:not(.mhead)');
  it('merchants: most-used first, paged, showing what you have chosen for each; they only suggest and a rule can be made from one', async () => {
    const waiting = (await api('/api/inbox')).needsCategory.find((t) => t.merchant && t.kind !== 'greenlight_reclass'); // one answer of yours gives that merchant a history
    await api(`/api/transactions/${waiting.id}/categorize`, { method: 'POST', body: { categoryId: (await api('/api/categories')).find((c) => c.name === 'Groceries').id } });
    await mount('/rules');
    byText('button', /^Merchants/).click();
    await waitFor(() => mrows().length > 3, 'merchant rows');
    expect(mrows().length).to.be.at.most(50); // paged: never the whole merchant list
    expect(text($('.card.muted.small'))).to.match(/A merchant is a shop.*only ever suggests/);
    expect($('select[aria-label="Mode"]'), 'no per-merchant mode any more').to.not.exist;
    choose($('select[aria-label="Which merchants"]'), 'All merchants');
    setInput($('input[type=search]'), waiting.merchant);
    await waitFor(() => $$('.mhist .chip').length > 0, 'history chips');
    const withHist = mrows().find((r) => $('.mhist .chip.top', r));
    expect(text($('.mhist .chip.top', withHist)), 'category and how many times').to.match(/×\d+/);
    byText('button', /Make a rule/, withHist).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Make a rule for/.test(text(d))), 'rule dialog');
    expect($('hk-category-select input', dlg).value, 'its usual category is pre-filled').to.equal($('.mhist .chip.top', withHist).dataset.cat);
    await waitFor(() => /would have matched \d+/i.test(text($('.rf-bt', dlg))), 'backtest');
    setInput($('input.rf-pri', dlg), '40');
    $('button.rf-save', dlg).click();
    await waitFor(async () => (await api('/api/rules')).some((r) => /from merchant/.test(r.notes ?? '') && r.priority === 40 && r.origin === 'user'), 'rule saved as yours');
    expect(text($$('.toast').at(-1))).to.match(/Rule saved/);
  });

  it('Fix name… explains rename and merge', async () => {
    await mount('/rules');
    byText('button', /^Merchants/).click();
    await waitFor(() => mrows().length > 3, 'merchant rows');
    byText('button', /Fix name/, mrows()[0]).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    expect(text(dlg)).to.match(/Rename changes how the name is shown.*Merge is for when two entries are really the same shop/);
    byText('button', /^Cancel$/, dlg).click();
  });
});

describe('Months checklist and dashboard', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows every month newest first with what is left to do and quick numbers; finished months fold away', async () => {
    const months = await api('/api/months');
    await mount('/months');
    await waitFor(() => $$('details.month').length > 0, 'month cards');
    const cards = $$('details.month');
    expect(cards.length).to.equal(Math.min(12, months.length));
    expect(cards[0].dataset.month).to.equal(months[0].month); expect(text(cards[0])).to.match(/this month/);
    expect(text($('summary', cards[0]))).to.match(/In \$[\d,]+\.\d{2}.*Spent \$.*plan \$.*txns/); // quick numbers on the one-line summary
    for (const [i, m] of months.slice(0, cards.length).entries()) expect(cards[i].open, `${m.month} open iff something to do`).to.equal(m.todo > 0);
    const withWork = $$('details.month').find((c) => $('.mcheck.todo', c));
    expect(withWork, 'the demo has something to do somewhere').to.exist;
    const todo = $('.mcheck.todo', withWork); expect($('a.mfix', todo).getAttribute('href')).to.match(/^#\//);
    expect(text($('#months-summary'))).to.match(/\d+ of \d+ months? (has|have) something to do/);
  });

  it('a fix link opens exactly those transactions, with a way back', async () => {
    const months = await api('/api/months');
    const m = months.find((x) => x.items.find((i) => i.key === 'category' && i.count > 0));
    expect(m, 'a month with uncategorized transactions').to.exist;
    const want = m.items.find((i) => i.key === 'category').count;
    await mount('/months');
    const card = await waitFor(() => $$('details.month').find((c) => c.dataset.month === m.month), 'month card');
    $('.mcheck[data-key=category] a.mfix', card).click();
    await waitFor(() => /#\/transactions/.test(location.hash), 'transactions page');
    await waitFor(() => $('.needs-chip'), 'filter chip');
    expect(text($('.needs-chip'))).to.match(/need a category/);
    await waitFor(() => /of \d+/.test(text($('.pager'))), 'pager');
    expect(text($('.pager'))).to.match(new RegExp(`of ${want}\\b`));
    byText('button', /Back to Months/).click();
    await waitFor(() => $('details.month'), 'back on Months');
  });

  it('"only months with something to do" hides finished months', async () => {
    const months = await api('/api/months');
    await mount('/months');
    await waitFor(() => $$('details.month').length > 0, 'cards');
    const box = byText('label', /Only months with something to do/); $('input', box).click();
    await waitFor(() => $$('details.month').every((c) => $('.badge.warn', c)), 'only unfinished months');
    expect($$('details.month').length).to.equal(Math.min(12, months.filter((x) => x.todo > 0).length));
  });

  it('the old /close address still lands on Months', async () => {
    location.hash = '#/close';
    await mount('/close');
    await waitFor(() => /Months/.test(text($('h1'))), 'Months page');
  });

  it('dashboard shows months to tidy and coverage', async () => {
    await mount('/dashboard');
    await waitFor(() => /Months to tidy/.test(text(document.body)) && /Health/.test(text(document.body)), 'dashboard callouts');
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
    await waitFor(() => $('#quiet'), 'prefs');
    expect($('#push')).to.not.exist; // no separate master switch: each device is on or off by itself
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

describe('Settings: notification devices', () => {
  let trap, real;
  beforeEach(async () => { await reset(); trap = trapErrors(); real = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker'); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); if (real) Object.defineProperty(navigator, 'serviceWorker', real); else delete navigator.serviceWorker; });
  const sub = (endpoint, ua) => api('/__e2e/push-device', { method: 'POST', body: { endpoint, ua } });
  /** Pretend this browser holds a push subscription (headless Chrome has no push service). */
  const thisBrowserIs = (endpoint) => Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => undefined, controller: null, ready: Promise.resolve({ pushManager: { getSubscription: async () => (endpoint ? { endpoint, unsubscribe: async () => true } : null) } }) } });

  it('lists the devices, marks this one, offers Turn off here, and removes a device after confirming', async () => {
    await sub('https://push.example/phone', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120 Mobile Safari/537.36');
    await sub('https://push.example/laptop', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120');
    thisBrowserIs('https://push.example/phone');
    await mount('/settings');
    await waitFor(() => $$('#devices .device').length === 2, 'two devices listed');
    const names = $$('#devices .device').map((d) => text(d));
    expect(names.some((n) => /Chrome on Android/.test(n) && /This device/.test(n))).to.equal(true);
    expect(names.some((n) => /Edge on Windows/.test(n) && !/This device/.test(n))).to.equal(true);
    expect($('#disable')).to.exist; expect($('#enable')).to.not.exist; // this browser is subscribed: the button now turns it off
    expect(text($('#disable'))).to.match(/Turn off notifications on this device/);
    byText('button', /^Remove$/, $$('#devices .device').find((d) => /Edge/.test(text(d)))).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Stop notifications to Edge on Windows/.test(text(d))), 'confirm');
    byText('button', /Remove device/, dlg).click();
    await waitFor(async () => (await api('/api/push/devices')).length === 1, 'device removed on the server');
    await waitFor(() => $$('#devices .device').length === 1, 'list updated');
  });

  it('on a browser that is not subscribed the button offers to turn notifications on', async () => {
    await sub('https://push.example/other', 'Mozilla/5.0 (iPhone) Safari/604');
    thisBrowserIs(null);
    await mount('/settings');
    await waitFor(() => $('#enable'), 'enable button');
    expect(text($('#enable'))).to.match(/Turn on notifications on this device/);
    expect($('#disable')).to.not.exist;
    expect(text($('#devices'))).to.match(/Safari on iPhone/);
    expect($('#devices .device .badge')).to.not.exist; // none of the listed devices is this one
  });

  it('turning off here removes this device from the list', async () => {
    await sub('https://push.example/me', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120');
    thisBrowserIs('https://push.example/me');
    await mount('/settings');
    await waitFor(() => $('#disable'), 'disable button');
    $('#disable').click();
    await waitFor(async () => (await api('/api/push/devices')).length === 0, 'unsubscribed on the server');
    await waitFor(() => $('#enable') && /No devices yet/.test(text(document.body)), 'page now offers to turn on');
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

  it('uses the same rows as Home: one-off merchants share a list; a merchant with several holds rows under one bulk bar', async () => {
    const accts = await api('/api/accounts'); const chase = accts.find((a) => a.name === 'Chase Prime Visa').id;
    for (let i = 0; i < 3; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'TWINS CAFE', amountCents: -(700 + i) } });
    await mount('/backlog');
    const group = await waitFor(() => $$('.group').find((c) => /TWINS CAFE/.test(text(c))), 'group');
    expect($$('.trow.txn', group).length, 'one row per transaction').to.equal(3);
    expect($('.bulkbar', group), 'one bulk bar').to.exist;
    expect($('.tcat hk-category-select', $('.trow.txn', group)), 'each row has its own category dropdown').to.exist;
    const ones = $('[data-ones]'); expect(ones, 'a list of one-off merchants').to.exist;
    const lone = $$('.trow.txn', ones).find((c) => /SEQUOIA PAYROLL/.test(text(c)));
    expect(lone, 'a single-transaction merchant is just a row').to.exist;
    expect(lone.closest('.group')).to.equal(null);
  });

  it('"pending" explains itself', async () => {
    await mount('/transactions');
    const badge = await waitFor(() => $$('.badge.warn').find((b) => /pending/.test(text(b))), 'a pending transaction');
    expect(badge.dataset.tip).to.match(/real-time alert.*bank has not posted it yet.*replaces this one and keeps your category/);
  });

  it('one answer categorizes every transaction of a merchant, teaches its history, and creates no rule by itself', async () => {
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
    expect((await api('/api/rules')).some((r) => /BRAND NEW BAKERY/i.test(r.match_json)), 'no rule unless you ask for one').to.equal(false);
  });
});

describe('Rules: disabled rules can be hidden and sort last', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('disabling a rule hides it by default; Show disabled brings it back at the bottom, dimmed; Enable returns it to its place', async () => {
    const before = await api('/api/rules'); const active = before.filter((r) => r.enabled).length;
    await mount('/rules');
    const rows = () => $$('tbody tr');
    await waitFor(() => rows().length === Math.min(50, active), 'only active rules');
    expect($('#show-off'), 'no checkbox while nothing is disabled').to.not.exist;
    const nameOf = (r) => text(r.children[1]); const firstName = nameOf(rows()[0]);
    byText('button', /^Disable$/, rows()[0]).click();
    await waitFor(() => rows().length === active - 1 && $('#show-off'), 'rule hidden and the checkbox offered');
    expect(text($$('button').find((b) => /^Rules/.test(text(b))))).to.match(new RegExp(`Rules \\(${active - 1} of ${before.length}\\)`));
    expect(text($$('.toast').at(-1))).to.match(/disabled and hidden/);
    $('#show-off').click();
    await waitFor(() => rows().length === active, 'disabled rule shown');
    const last = rows().at(-1); expect(nameOf(last)).to.equal(firstName); // sorted below every active rule
    expect(last.style.opacity).to.equal('0.5');
    expect(rows().slice(0, -1).every((r) => r.style.opacity !== '0.5')).to.equal(true);
    byText('button', /^Enable$/, last).click();
    await waitFor(() => nameOf(rows()[0]) === firstName, 'enabled rule back at the top by priority');
    expect($('#show-off'), 'checkbox gone again').to.not.exist;
  });
});

describe('Backlog: paged, with a loading state and a blocking "working" modal', () => {
  let trap, real;
  beforeEach(async () => { await reset(); trap = trapErrors(); real = window.fetch; });
  afterEach(() => { window.fetch = real; trap.stop(); expect(trap.errs).to.deep.equal([]); });
  const slow = (re, ms) => { window.fetch = (u, o) => (re.test(String(u)) ? new Promise((r) => setTimeout(r, ms)).then(() => real(u, o)) : real(u, o)); };
  const seed = async (n, per = 2) => { const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id; for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: `PAGER SHOP ${String(i).padStart(2, '0')}`, amountCents: -(300 + i * 7 + k) } }); };

  it('shows a loading card first, then one page of merchants with the same controls as the other tables', async () => {
    await seed(14);
    slow(/\/api\/backlog/, 500);
    await mount('/backlog');
    await waitFor(() => $('.loadingcard'), 'loading card'); expect(text($('.loadingcard'))).to.match(/Loading the backlog/);
    await waitFor(() => $('.pager'), 'the list'); expect($('.loadingcard')).to.not.exist;
    window.fetch = real;
    const groups = () => $$('.group').filter((g) => /PAGER SHOP/.test(text(g)));
    await waitFor(() => $$('.group').length >= 1, 'groups');
    expect($$('.group').length, 'at most one page of merchants (10)').to.be.at.most(10);
    const info = text($('.pager')); expect(info).to.match(/1–10 of \d+/); const total = Number(/of (\d+)/.exec(info)[1]);
    expect(total).to.be.greaterThan(14);
    expect(text($('.tabs'))).to.match(/Needs a category \(\d+\)/);
    // next page
    const firstKeys = $$('.group').map((g) => g.dataset.key);
    $('button.next').click(); await waitFor(() => /11–/.test(text($('.pager'))), 'page 2');
    await waitFor(() => $$('.group').length && $$('.group').every((g) => !firstKeys.includes(g.dataset.key)), 'different merchants on page 2');
    $('button.first').click(); await waitFor(() => /^1–/.test(text($('.pager')).replace(/^\D+/, '')) || /1–10/.test(text($('.pager'))), 'back to page 1');
    // rows per page
    choose($('select.size'), '5'); await waitFor(() => /1–5 of/.test(text($('.pager'))), '5 per page'); expect($$('.group').length).to.be.at.most(5);
    // server-side filter
    const box = $('input[type=search]'); setInput(box, 'PAGER SHOP 03');
    await waitFor(() => /of 1\b/.test(text($('.pager'))) || /1–2 of 2/.test(text($('.pager'))) || groups().length === 1, 'filtered');
    expect(groups().length).to.equal(1);
  });

  it('answering a group blocks all input behind a working modal until the page has refreshed, then shows the result', async () => {
    await seed(3, 3);
    await mount('/backlog');
    const group = await waitFor(() => $$('.group').find((g) => /PAGER SHOP 02/.test(text(g))), 'a group');
    slow(/\/api\/inbox\/bulk/, 900);
    await pickCat($('.bulkbar hk-category-select', group), 'Eating Out');
    await confirmDialog(/Yes, categorize/);
    const busy = await waitFor(() => $('dialog.busy[open]'), 'the working modal');
    expect(busy.matches(':modal'), 'a real modal: the page behind cannot be used').to.equal(true);
    expect(text(busy)).to.match(/Categorizing 3 transactions from PAGER SHOP 02/);
    busy.dispatchEvent(new Event('cancel', { cancelable: true })); // Esc
    await sleep(50); expect($('dialog.busy[open]'), 'Esc does not dismiss it').to.exist;
    window.fetch = real;
    await waitFor(() => !$('dialog.busy'), 'the modal to go once the work is done', 15000);
    expect($$('.group').some((g) => /PAGER SHOP 02/.test(text(g))), 'the answered group is gone').to.equal(false);
    expect(text(document.body)).to.match(/PAGER SHOP 02: 3 categorized/);
    const tx = await api('/api/transactions?q=PAGER%20SHOP%2002'); expect(tx.every((t) => t.splits[0]?.category === 'Eating Out')).to.equal(true);
  });

  it('answering a single row also blocks input until the list is refreshed', async () => {
    await mount('/backlog');
    const row = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row');
    const id = row.dataset.id;
    slow(/\/categorize/, 700);
    await pickCat($('.tcat hk-category-select', row), 'Gas'); await confirmDialog(/Yes, categorize/);
    const busy = await waitFor(() => $('dialog.busy[open]'), 'the working modal'); expect(busy.matches(':modal')).to.equal(true);
    window.fetch = real;
    await waitFor(() => !$('dialog.busy'), 'modal gone', 15000);
    await waitFor(() => !$$('.trow.txn').some((r) => r.dataset.id === id), 'row left the list');
  });

  it('after a CSV import, Amazon / PayPal / Venmo charges are on the Waiting-on-notes tab straight away', async () => {
    const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n09/03/2026,09/04/2026,AMZN Mktp US*E2E1,Shopping,Sale,-23.99,\n09/05/2026,09/06/2026,PAYPAL *E2E SHOP,Shopping,Sale,-30.00,\n09/07/2026,09/08/2026,TRADER JOES E2E,Groceries,Sale,-44.00,\n';
    const m = await api('/api/imports/suggest-mapping', { method: 'POST', body: { csv } });
    const r = await api('/api/imports/commit', { method: 'POST', body: { institution: 'Chase', csv, accountId: chase, spec: { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 } } });
    expect(r.imported).to.equal(3); expect(r.waitingOnNotes).to.equal(2);
    await mount('/backlog');
    await waitFor(() => /Waiting on notes \(\d+\)/.test(text($('.tabs'))), 'tabs');
    byText('button', /^Waiting on notes/).click();
    await waitFor(() => $$('.trow.txn').some((x) => /AMZN Mktp US\*E2E1/.test(text(x))) && $$('.trow.txn').some((x) => /PAYPAL \*E2E SHOP/.test(text(x))), 'the wrapper charges');
    expect($$('.trow.txn').some((x) => /TRADER JOES E2E/.test(text(x)))).to.equal(false);
    expect($$('.trow.txn').every((x) => x.dataset.note === 'missing')).to.equal(true);
  });
});

describe('Rule priority and splitting from the Backlog', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('priority is editable on every rule, explained, rejects nonsense, and re-orders the list', async () => {
    await mount('/rules');
    const rows = () => $$('tbody tr'); await waitFor(() => rows().length > 2, 'rules');
    expect(text($$('p.muted.small').find((p) => /lowest priority number/.test(text(p))))).to.match(/more conditions|more specific/);
    const pri = (r) => $('input.rule-pri', r); const nameOf = (r) => text(r.children[1]);
    const first = rows()[0], second = rows()[1]; const secondName = nameOf(second);
    expect(Number(pri(first).value)).to.be.at.most(Number(pri(second).value));
    setInput(pri(first), '0'); pri(first).dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => /whole number from 1 to 9999/.test(text($$('.toast').at(-1))), 'rejected'); expect(Number(pri(rows()[0]).value)).to.be.greaterThan(0);
    setInput(pri(second), '1'); pri(second).dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => nameOf(rows()[0]) === secondName && Number(pri(rows()[0]).value) === 1, 'second rule moved to the top');
    const saved = (await api('/api/rules')).find((r) => r.priority === 1); expect(saved).to.exist;
  });

  it('a transaction can be split between categories from the Backlog, with the parts forced to add up', async () => {
    await mount('/backlog');
    const row = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((r) => /NEW CAFE|SEPHORA/.test(text(r))), 'a row');
    const id = row.dataset.id; const before = (await api(`/api/transactions?q=${encodeURIComponent(text($('.tdesc', row)))}`)).find((t) => String(t.id) === id);
    const total = Math.abs(before.amount_cents);
    $('.texpand', row).click(); byText('button', /^Split…$/, row).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /^Split /.test(text($('h3', d) ?? d))), 'split dialog');
    const save = $('button.splitsave', dlg); expect(save.disabled, 'nothing chosen yet').to.equal(true);
    const [c1, c2] = $$('hk-category-select', dlg); const [a1, a2] = $$('input.splitamt', dlg);
    expect(a1.value).to.equal((total / 100).toFixed(2)); expect(a2.value).to.equal('0.00');
    await pickCat(c1, 'Groceries'); await pickCat(c2, 'Eating Out');
    expect(save.disabled, 'the second part is 0.00').to.equal(true);
    const first = Math.floor(total / 2);
    setInput(a1, (first / 100).toFixed(2)); a1.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => /left to place/.test(text($('.splitleft', dlg))), 'remaining shown'); expect(save.disabled).to.equal(true);
    setInput(a2, ((total - first) / 100).toFixed(2)); a2.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => /Adds up/.test(text($('.splitleft', dlg))) && !save.disabled, 'adds up and enabled');
    save.click();
    await waitFor(() => !$$('.trow.txn').some((r) => r.dataset.id === id), 'the row left the backlog');
    const after = (await api(`/api/transactions?q=${encodeURIComponent(before.descriptor_raw)}`)).find((t) => String(t.id) === id);
    expect(after.splits.map((s) => s.category).sort()).to.deep.equal(['Eating Out', 'Groceries']);
    expect(after.splits.reduce((a, s) => a + s.amount_cents, 0)).to.equal(before.amount_cents);
    expect(after.splits.every((s) => Math.sign(s.amount_cents) === Math.sign(before.amount_cents))).to.equal(true);
  });

  it('"Split evenly" and extra parts work, and Cancel changes nothing', async () => {
    await mount('/backlog');
    const row = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row'); const id = row.dataset.id;
    $('.texpand', row).click(); byText('button', /^Split…$/, row).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && $('.splitsave', d)), 'split dialog');
    $('button.splitadd', dlg).click(); await waitFor(() => $$('.splitrow', dlg).length === 3, 'third part');
    $('button.spliteven', dlg).click();
    await waitFor(() => /Amounts add up/.test(text($('.splitleft', dlg))), 'even split adds up (categories still to choose)'); expect($('button.splitsave', dlg).disabled).to.equal(true);
    const cents = $$('input.splitamt', dlg).map((i) => Math.round(parseFloat(i.value) * 100)); expect(Math.max(...cents) - Math.min(...cents)).to.be.at.most(2);
    byText('button', /^Cancel$/, dlg).click();
    await waitFor(() => !dlg.open, 'closed');
    expect($$('.trow.txn').some((r) => r.dataset.id === id)).to.equal(true); // untouched
  });
});
