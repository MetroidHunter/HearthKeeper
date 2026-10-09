import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, setInput, confirmDialog, pickCat, sleep } from './helpers.js';

const wb0 = (list) => list[0].remainingCents;

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
    expect($$('.wkseg', card).length).to.be.greaterThan(3);
    expect($$('.wkseg.current', card)).to.have.length(1);
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
    const row = $('.wkseg.current', card);
    expect($('.wkseg-left', row).classList.contains('neg')).to.equal(true);
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
    const row = await waitFor(() => $('section.wk.span'), 'the weekly budget on Home');
    expect(text($('.wk-name', row))).to.equal('Groceries Weekly');
    expect(text($('.wk-total', row))).to.contain(`${fmt(wb0(await api('/api/weekly-budgets')))} left of $800.00`);
    expect($$('.wkseg', row).length).to.be.greaterThan(3);                          // the same bar as on Budget
    expect($('.wk-edit', row)).to.not.exist;
    expect(row.classList.contains('card')).to.equal(true);                           // a card, like the others
    expect(getComputedStyle(row).borderTopWidth).to.not.equal('0px');
    const grid = $('.favs');
    expect(grid.firstElementChild).to.equal(row);                                    // weekly budgets come first
    expect(row.getBoundingClientRect().width).to.be.at.least(grid.getBoundingClientRect().width - 1);   // across every column
    $('.wk-fav', row).click();                                                       // unpin from Home
    await waitFor(() => !$('section.wk.span'), 'unpinned');
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

  it('fits a phone: one full-width strip of week bars (no wrapping), the chosen week\'s numbers underneath, tap another week to switch', async () => {
    const cats = await api('/api/categories');
    const r = await api('/api/weekly-budgets', { method: 'POST', body: { categoryId: cats.find((c) => c.name === 'Car Insurance').id } });
    await api(`/api/weekly-budgets/${r.id}/favorite`, { method: 'POST' });
    await setViewport({ width: 390, height: 800 });
    try {
      await mount('/budget');
      const card = await waitFor(() => $('section[data-weekly]'), 'card');
      expect(document.documentElement.scrollWidth).to.be.at.most(390);
      const segs = $$('.wkseg', card);
      expect(new Set(segs.map((x) => Math.round(x.getBoundingClientRect().top))).size).to.equal(1);                       // all in one row
      const strip = $('.wkbars', card).getBoundingClientRect();
      expect(segs.at(-1).getBoundingClientRect().right).to.be.at.least(strip.right - 1);                                      // across the full width
      expect(getComputedStyle($('.wkseg-top', segs[0])).display).to.equal('none');                                            // the per-week text is folded away
      const shown = () => $$('.wkd', card).filter((d) => getComputedStyle(d).display !== 'none');
      expect(shown()).to.have.length(1);
      expect(shown()[0].dataset.week).to.equal(String($('.wkseg.current', card).dataset.week));                               // this week to begin with
      expect(text(shown()[0])).to.match(/\$[\d,.]+\/\$[\d,.]+/);
      segs[0].click();
      await waitFor(() => shown().length === 1 && shown()[0].dataset.week === '1', 'the tapped week\'s numbers');
      await mount('/');
      const row = await waitFor(() => $('section.wk.span'), 'the weekly budget on Home');
      expect(document.documentElement.scrollWidth).to.be.at.most(390);
      expect(getComputedStyle($('.wkd.sel', row)).display).to.equal('flex');
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
    expect(text($('.wkseg-left', now))).to.match(/^\$[\d,.]+$/);                                                 // just the amount, no words
    expect(text($('.wkseg-nums', now))).to.match(/^\$[\d,.]+\/\$[\d,.]+$/);                                         // spent/budget in the top corner
    expect($('.wkseg-top', now).lastElementChild).to.equal($('.wkseg-nums', now));
    expect(now.textContent).to.not.match(/left|carried|over/i);
    expect(text($('.wkseg-nums', now))).to.contain(`/$${(cur.allottedCents / 100).toFixed(2)}`);                    // the week's budget, after what was spent
    await api('/api/transactions', { method: 'POST', body: { accountId: accts[0].id, descriptor: 'OOPS', amountCents: -500000, categoryId: eat.id } });
    await mount('/budget');
    const over = await waitFor(() => $('.wkseg.current.over'), 'the week turns red when it goes over');
    expect(text($('.wkseg-left', over))).to.match(/^-\$[\d,.]+$/);
    expect($('.wkbar > i', over).style.width).to.equal('100%');
  });
});
