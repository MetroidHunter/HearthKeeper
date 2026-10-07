import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, pickCat, sleep } from './helpers.js';

const backdropClick = (dlg) => dlg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })); // far outside the dialog box
const paddingClick = (dlg) => { const r = dlg.getBoundingClientRect(); dlg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3 })); };

describe('Dialogs and pop-ups', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); $$('dialog').forEach((d) => d.remove()); $$('.cs-pop').forEach((p) => p.remove()); });

  it('the category list opens above a modal dialog, not behind it', async () => {
    await mount('/');
    byText('button', /Add transaction/).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Add a transaction/.test(text(d))), 'add dialog');
    const picker = $('hk-category-select', dlg);
    $('input', picker).focus();
    const pop = await waitFor(() => $('.cs-pop'), 'category list');
    expect(dlg.contains(pop)).to.equal(true); // it lives inside the dialog, so it is in the same top layer
    const r = pop.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
    expect(pop.contains(hit)).to.equal(true); // the first thing under the pointer is the list, not the dialog behind it
  });

  it('clicking outside an informational dialog closes it; padding clicks and decision dialogs stay', async () => {
    await mount('/');
    const card = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row');
    $('.texpand', card).click();
    byText('button', /Show nearby transactions/, card).click();
    let dlg = await waitFor(() => $$('dialog').find((d) => d.open && $('.ctx-row', d)), 'context dialog');
    paddingClick(dlg); await sleep(50);
    expect(dlg.open).to.equal(true); // inside the dialog's own padding is not "outside"
    backdropClick(dlg); await waitFor(() => !dlg.isConnected || !dlg.open, 'closed by outside click');
    // a dialog that asks for a decision does not dismiss on an outside click
    await pickCat($('.tcat hk-category-select', card), 'Gas');
    dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'confirm dialog');
    backdropClick(dlg); await sleep(100);
    expect(dlg.open).to.equal(true);
    byText('button', /^Cancel$/, dlg).click();
  });

  it('the transaction detail closes on an outside click', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 3, 'rows');
    $$('tbody tr')[2].click();
    const dlg = await waitFor(() => $('dialog.txn-detail[open]'), 'detail');
    backdropClick(dlg);
    await waitFor(() => !$('dialog.txn-detail'), 'detail closed');
  });
});

describe('Navigation menus', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  const menu = (name) => $$('nav.top details').find((d) => new RegExp(`^${name}`).test(text($('summary', d))));
  it('opening one menu closes the others; a top-level link, Escape, or its own heading closes it', async () => {
    await mount('/');
    $('summary', menu('Data')).click(); await waitFor(() => menu('Data').open, 'data open');
    $('summary', menu('Discover')).click(); await waitFor(() => menu('Discover').open && !menu('Data').open, 'data closed when discover opened');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await waitFor(() => !menu('Discover').open, 'escape closes');
    $('summary', menu('Settings')).click(); await waitFor(() => menu('Settings').open, 'settings open');
    byText('nav.top > a', /^Budget/).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await waitFor(() => !menu('Settings').open, 'top-level link closes the menu');
    $('summary', menu('Data')).click(); await waitFor(() => menu('Data').open, 'reopen');
    $('summary', menu('Data')).click(); await waitFor(() => !menu('Data').open, 'its own heading closes it');
  });
});

describe('Hints, budget numbers, charts', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); localStorage.removeItem('hk-theme'); document.documentElement.removeAttribute('data-theme'); });

  it('hover hints ignore the pointer once it leaves the item (the hint itself never keeps them open)', async () => {
    await mount('/transactions');
    await waitFor(() => $('thead th[data-tip]'), 'headers');
    expect(getComputedStyle($('thead th[data-tip]'), '::after').pointerEvents).to.equal('none');
  });

  it('"Not a budget item" explains itself on hover', async () => {
    await mount('/');
    const b = await waitFor(() => byText('button', /Not a budget item/), 'button');
    expect(b.dataset.tip).to.match(/transfer between your own accounts/);
    expect(b.dataset.tip).to.match(/Restore/);
  });

  it('budget: balances are large, green when positive, red when negative, and groups carry no roll-up totals', async () => {
    await mount('/budget');
    await waitFor(() => $$('section.group tbody tr').length > 5, 'rows');
    const cell = $$('section.group tbody td.num').find((c) => /^\$[\d,]+\.\d\d$/.test(text(c)) && c.classList.contains('pos'));
    expect(cell, 'a positive balance').to.exist;
    expect(parseFloat(getComputedStyle(cell).fontSize)).to.be.at.least(19);
    expect(getComputedStyle(cell).color).to.equal(getComputedStyle(document.documentElement.appendChild(Object.assign(document.createElement('i'), { className: 'pos' }))).color);
    for (const g of $$('section.group')) expect(text($('.row', g))).to.not.match(/Target|Spent|Left/);
  });

  it('dark mode: chart text and tooltips use the theme colors', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    await mount('/budget');
    await waitFor(() => $$('button').find((b) => /^Pie$/.test(text(b))), 'pie tab');
    byText('button', /^Pie$/).click();
    const el = await waitFor(() => $('.chart canvas') && $('.chart'), 'pie');
    const { loadCharts } = await import('../src/web/charts.ts');
    const e = await loadCharts();
    const opt = e.getInstanceByDom(el).getOption();
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    expect([].concat(opt.series[0].label)[0].color.toLowerCase()).to.equal(ink.toLowerCase());
    expect(opt.tooltip[0].textStyle.color.toLowerCase()).to.equal(ink.toLowerCase());
    expect(opt.tooltip[0].backgroundColor.toLowerCase()).to.equal(getComputedStyle(document.documentElement).getPropertyValue('--card').trim().toLowerCase());
  });

  it('analytics has no heatmap, and budget vs actual gives every category its own room', async () => {
    await mount('/analytics');
    expect(byText('button', /^Heatmap$/)).to.not.exist;
    const rows = await api('/api/analytics/budget-vs-actual');
    const el = await waitFor(() => $('.chart canvas') && $('.chart'), 'chart');
    expect(parseInt(el.style.height)).to.equal(Math.max(360, rows.length * 40 + 90));
  });
});

describe('Categories: the reserved import category stays out of sight', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); $$('.cs-pop').forEach((p) => p.remove()); });
  it('is not listed on Categories, not offered in any picker, but its name shows on the transaction that carries it', async () => {
    const accts = await api('/api/accounts');
    const created = await api('/__e2e/seed-reserved', { method: 'POST' }); // creates the reserved category and one imported-style transaction
    expect(created.categoryId).to.be.a('number');
    await mount('/categories');
    await waitFor(() => $$('tbody tr').length > 3, 'rows');
    expect(text(document.body)).to.not.match(/Predates Oct 2026 Seed/);
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').some((r) => /RESERVED IMPORT ROW/.test(text(r))), 'the imported row');
    expect(text($$('tbody tr').find((r) => /RESERVED IMPORT ROW/.test(text(r))))).to.match(/Predates Oct 2026 Seed/);
    const picker = $('hk-category-select'); $('input', picker).focus(); setTimeout(() => {}, 0);
    await waitFor(() => $$('.cs-pop .opt').length > 5, 'list');
    expect($$('.cs-pop .opt').some((o) => /Predates Oct 2026 Seed/.test(text(o)))).to.equal(false);
    void accts;
  });
});
