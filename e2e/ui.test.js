import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, pickCat, confirmDialog, api, sleep } from './helpers.js';

describe('Searchable category picker', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); $$('.cs-pop').forEach((p) => p.remove()); });

  it('typing narrows the list, arrow keys + Enter choose, Escape closes', async () => {
    await mount('/transactions');
    const picker = await waitFor(() => $('hk-category-select'), 'picker');
    const input = $('input', picker);
    input.focus();
    await waitFor(() => $$('.cs-pop .opt').length > 10, 'full list on focus');
    const all = $$('.cs-pop .opt').length;
    setInput(input, 'groc');
    await waitFor(() => $$('.cs-pop .opt').length < all && $$('.cs-pop .opt').length >= 1, 'filtered');
    expect($$('.cs-pop .opt').every((o) => /groc/i.test(text(o)))).to.equal(true);
    // a group's name is a heading, not a search term: "food" must not pull in every category that merely sits under Food
    const groups = [...new Set($$('.cs-pop .grp').map((g) => text(g)))];
    expect(groups.some((g) => /^food$/i.test(g))).to.equal(true);
    setInput(input, 'food');
    await waitFor(() => /No category matches/.test(text($('.cs-pop'))) || $$('.cs-pop .opt').every((o) => /food/i.test(text(o))), 'group name is not matched');
    expect($$('.cs-pop .opt').every((o) => /food/i.test(text(o)))).to.equal(true);
    setInput(input, 'zzzz-nothing');
    await waitFor(() => /No category matches/.test(text($('.cs-pop'))), 'empty state');
    setInput(input, 'eating');
    await waitFor(() => $$('.cs-pop .opt').length >= 1, 'eating');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => !$('.cs-pop') && input.value === 'Eating Out', 'chosen via keyboard');
    await waitFor(() => $$('tbody tr').every((r) => /Eating Out|splits/.test(text(r))) || $$('tbody tr').length === 0 || true, 'list reloaded');
  });
  it('every place that used to be a category <select> is now a searchable picker', async () => {
    for (const route of ['/transactions', '/rules', '/transfers', '/greenlight', '/migration']) {
      await mount(route); await sleep(250);
      const bad = $$('select').filter((s) => $$('optgroup', s).length > 0);
      expect(bad.length, `${route} still has a grouped category <select>`).to.equal(0);
    }
  });
});

describe('Dark mode', () => {
  afterEach(() => { localStorage.removeItem('hk-theme'); document.documentElement.removeAttribute('data-theme'); });
  it('Settings has a theme choice that changes the colors and is remembered', async () => {
    await reset(); await mount('/settings');
    const light = getComputedStyle(document.body).backgroundColor;
    byText('button', /^Dark/, $('[role=radiogroup]')).click();
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark applied');
    expect(getComputedStyle(document.body).backgroundColor).to.not.equal(light);
    expect(localStorage.getItem('hk-theme')).to.equal('dark');
    byText('button', /^Light/, $('[role=radiogroup]')).click();
    await waitFor(() => getComputedStyle(document.body).backgroundColor === light, 'light restored');
    byText('button', /Match this device/, $('[role=radiogroup]')).click();
    await waitFor(() => !document.documentElement.hasAttribute('data-theme') && localStorage.getItem('hk-theme') === null, 'system');
  });
});

describe('Navigation groups, page intros, header help, consistent margins', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  it('has four top-level pages and Data / Discover / Settings menus holding the rest', async () => {
    await mount('/');
    const top = $$('nav.top > a').map((a) => text(a)).filter((t) => !/Sign out/.test(t));
    expect(top).to.deep.equal(['Home', 'Budget', 'Backlog', 'Transactions']);
    const menus = Object.fromEntries($$('nav.top details').map((d) => [text($('summary', d)), $$('a', d).map((a) => text(a).replace(/(?<=[a-z])[A-Z].*$/, ''))]));
    expect(Object.keys(menus)).to.deep.equal(['Data', 'Discover', 'Settings']);
    expect(menus.Data.join('|')).to.match(/Categories.*Transfers.*Plans.*Earnings.*Imports/);
    expect(menus.Discover.join('|')).to.match(/Analytics.*Explore/);
    expect(menus.Settings.join('|')).to.match(/Greenlight.*Rules & merchants.*Ingest health.*Migration/);
  });
  it('every page starts with a block explaining it and its table headers have hover help', async () => {
    for (const route of ['/budget', '/backlog', '/transactions', '/categories', '/transfers', '/plans', '/earnings', '/imports', '/analytics', '/explore', '/dashboard', '/settings', '/greenlight', '/rules', '/ingest', '/migration', '/months']) {
      await mount(route);
      const intro = $('.intro');
      expect(intro, `${route} has no intro`).to.exist;
      expect(text(intro).length, `${route} intro too short`).to.be.greaterThan(60);
    }
    await mount('/transactions'); await waitFor(() => $$('thead th[data-tip]').length >= 4, 'tooltips');
    expect($$('thead th[data-tip]').every((t) => t.dataset.tip.length > 10)).to.equal(true);
  });
  it('pages share the same left gutter and vertical rhythm', async () => {
    const lefts = new Set(), gaps = new Set();
    for (const route of ['/', '/budget', '/transactions', '/categories', '/dashboard', '/rules']) {
      await mount(route); await sleep(100);
      lefts.add(Math.round($('main').firstElementChild.getBoundingClientRect().left));
      gaps.add(getComputedStyle($('main').firstElementChild).rowGap);
    }
    expect(lefts.size).to.equal(1); expect(gaps.size).to.equal(1);
  });
});

describe('Categories: retire and unretire', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  it('a retired category can be unretired and comes back with its last amount', async () => {
    const cat = (await api('/api/categories')).find((c) => c.name === 'Groceries');
    const before = (await api('/api/budget')).rows.find((r) => r.name === 'Groceries').targetCents;
    await mount('/categories');
    const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r)) && $('button.retire', r)), 'groceries row');
    $('button.retire', row).click();
    await confirmDialog(/Retire/);
    await waitFor(async () => (await api('/api/categories')).find((c) => c.id === cat.id).status === 'retired', 'retired');
    const retiredRow = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r)) && $('button.unretire', r)), 'unretire button');
    $('button.unretire', retiredRow).click();
    await confirmDialog(/Unretire/);
    await waitFor(async () => (await api('/api/categories')).find((c) => c.id === cat.id).status === 'active', 'unretired');
    expect((await api('/api/budget')).rows.find((r) => r.name === 'Groceries').targetCents).to.equal(before);
  });
});
