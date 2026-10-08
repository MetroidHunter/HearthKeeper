import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, setInput, confirmDialog, pickCat, sleep } from './helpers.js';

describe('Weekly budgets', () => {
  let trap;
  beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '0'); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('create from the Budget page: a live week-by-week preview, then a section above the other budgets', async () => {
    await mount('/budget');
    await waitFor(() => $('.wk-new'), 'the new button');
    expect($('[data-weekly]')).to.not.exist;
    $('.wk-new').click();
    const dlg = await waitFor(() => $('dialog[open] hk-weekly-form'), 'the dialog');
    expect($('input[aria-label=Name]', dlg)).to.not.exist;               // no name or amount to type
    $('.wk-save', dlg).click();
    await waitFor(() => /Pick a category/.test(text($('.err', dlg))), 'a clear error when no category is chosen');
    await pickCat($('hk-category-select', dlg), 'Groceries');
    await waitFor(() => $$('.wk-preview tbody tr', dlg).length >= 4, 'a preview of the month\'s weeks');
    expect(text($('.wk-total-line', dlg))).to.match(/Groceries Weekly.*\$800\.00 a month/);
    const rows = $$('.wk-preview tbody tr', dlg).map((r) => $$('td', r).map(text));
    expect(rows.reduce((a, r) => a + Math.round(parseFloat(r[1].replace(/[$,]/g, '')) * 100), 0)).to.equal(80000);   // the weeks add up to the category's budget
    $('.wk-save', dlg).click();
    const card = await waitFor(() => $('section[data-weekly]'), 'the weekly budget');
    expect(text($('.wk-name', card))).to.equal('Groceries Weekly');
    expect(text($('.wk-total', card))).to.contain('left of $800.00 this month');
    expect($$('tbody tr.wk-row', card).length).to.be.greaterThan(3);
    expect($$('tbody tr.wk-row.current', card)).to.have.length(1);
    // it sits above the grouped budgets
    const kids = [...$('main').firstElementChild.children];
    expect(kids.indexOf(card)).to.be.lessThan(kids.findIndex((k) => k.matches('section.group')));
  });

  it('shows what is left per week and for the month, and an overspent week eats into the next', async () => {
    const cats = await api('/api/categories');
    const eat = cats.find((c) => c.name === 'Eating Out');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    await api('/api/weekly-budgets', { method: 'POST', body: { categoryId: eat.id, weekStart: 1 } });
    const accts = await api('/api/accounts');
    await api('/api/transactions', { method: 'POST', body: { accountId: accts[0].id, descriptor: 'BIG DINNER', amountCents: -300000, categoryId: eat.id } });
    const [b] = await api('/api/weekly-budgets');
    const fmt = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const cur = b.weeks.find((w) => w.state === 'current');
    expect(b.spentCents).to.be.at.least(300000);
    expect(cur.remainingCents).to.be.lessThan(0);
    await mount('/budget');
    const card = await waitFor(() => $('section[data-weekly]'), 'card');
    expect(text($('.wk-total', card))).to.contain(`${fmt(b.remainingCents)} left of ${fmt(b.amountCents)}`);
    expect(b.remainingCents).to.be.lessThan(0);
    const row = $('tr.wk-row.current', card);
    expect($('.wk-left', row).classList.contains('neg')).to.equal(true);
    const next = b.weeks.find((w) => w.n === cur.n + 1);
    if (next) expect(next.carriedCents).to.equal(cur.remainingCents);      // the overage is carried into the next week
    expect(today >= cur.from && today <= cur.to).to.equal(true);
  });

  it('favorite it and it appears on Home above the favorited budgets; edit and delete work', async () => {
    const cats = await api('/api/categories');
    const eat = cats.find((c) => c.name === 'Groceries');
    await api('/api/weekly-budgets', { method: 'POST', body: { categoryId: eat.id } });
    await mount('/budget');
    const fmt = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const card = await waitFor(() => $('section[data-weekly]'), 'card');
    $('.wk-fav', card).click();
    await waitFor(() => /★/.test(text($('.wk-fav'))), 'starred');
    await mount('/');
    const tile = await waitFor(() => $('.wk-tile'), 'a weekly tile on Home');
    expect(text(tile)).to.match(/Groceries Weekly/);
    const [wb] = await api('/api/weekly-budgets');
    expect(text(tile)).to.contain(`Month: ${fmt(wb.remainingCents)} left of $800.00`);
    const tiles = $$('.favs > .fav');
    expect(tiles[0]).to.equal(tile);                       // weekly budgets come first
    // edit, then delete
    await mount('/budget');
    $('.wk-edit').click();
    const dlg = await waitFor(() => $('dialog[open] hk-weekly-form'), 'edit dialog');
    await pickCat($('hk-category-select', dlg), 'Gas');
    $('.wk-save', dlg).click();
    await waitFor(() => /Gas Weekly/.test(text($('.wk-name'))) && /left of \$150\.00 this month/.test(text($('.wk-total'))), 'edited: now follows Gas and its budget');
    $('.wk-edit').click();
    const dlg2 = await waitFor(() => $('dialog[open] .wk-delete'), 'delete button');
    dlg2.click();
    await confirmDialog(/Delete/);
    await waitFor(() => !$('section[data-weekly]'), 'deleted');
    expect(await api('/api/weekly-budgets')).to.deep.equal([]);
  });

  it('fits a phone: no sideways page scroll on Budget or Home, and the weekly tile is still readable', async () => {
    const cats = await api('/api/categories');
    const r = await api('/api/weekly-budgets', { method: 'POST', body: { categoryId: cats.find((c) => c.name === 'Car Insurance').id } });
    await api(`/api/weekly-budgets/${r.id}/favorite`, { method: 'POST' });
    await setViewport({ width: 390, height: 800 });
    try {
      await mount('/budget');
      await waitFor(() => $('section[data-weekly]'), 'card');
      expect(document.documentElement.scrollWidth).to.be.at.most(390);
      await mount('/');
      const tile = await waitFor(() => $('.wk-tile'), 'tile');
      expect(document.documentElement.scrollWidth).to.be.at.most(390);
      expect(text(tile)).to.match(/\$/);
    } finally { await setViewport({ width: 1280, height: 800 }); }
  });

  it('draws the month as one bar cut into week pieces: as wide as the week has days, filled by spending, red when over, money above and below', async () => {
    const cats = await api('/api/categories');
    const eat = cats.find((c) => c.name === 'Eating Out');
    const accts = await api('/api/accounts');
    await api('/api/weekly-budgets', { method: 'POST', body: { categoryId: eat.id } });
    const [b0] = await api('/api/weekly-budgets');
    const cur = b0.weeks.find((w) => w.state === 'current');
    await api('/api/transactions', { method: 'POST', body: { accountId: accts[0].id, descriptor: 'HALF', amountCents: -Math.round(cur.availableCents / 2), categoryId: eat.id } });
    const [b] = await api('/api/weekly-budgets');
    await mount('/budget');
    const card = await waitFor(() => $('section[data-weekly]'), 'card');
    const segs = $$('.wkbars .wkseg', card);
    expect(segs).to.have.length(b.weeks.length);
    segs.forEach((seg, i) => expect(getComputedStyle(seg).flexGrow).to.equal(String(b.weeks[i].days)));      // a short week is a short piece
    const now = $('.wkseg.current', card);
    expect(now).to.exist;
    expect(Math.round(parseFloat($('.wkbar > i', now).style.width))).to.be.within(49, 51);                    // half spent, half the bar
    expect($('.wk-now', now)).to.exist;                                                                         // today's marker
    expect(text($('.wkseg-left', now))).to.match(/\$[\d,.]+ left/);
    expect(text($('.wkseg-top', now))).to.contain(`$${(cur.allottedCents / 100).toFixed(2)}`);                  // the week's budget above the bar
    await api('/api/transactions', { method: 'POST', body: { accountId: accts[0].id, descriptor: 'OOPS', amountCents: -500000, categoryId: eat.id } });
    await mount('/budget');
    const over = await waitFor(() => $('.wkseg.current.over'), 'the week turns red when it goes over');
    expect(text($('.wkseg-left', over))).to.match(/^-\$.*over$/);
    expect($('.wkbar > i', over).style.width).to.equal('100%');
  });
});
