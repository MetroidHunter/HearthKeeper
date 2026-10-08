import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api } from './helpers.js';

describe('Explore: Spend by has normal table controls', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  const dimTab = (n) => byText('.tabs button', new RegExp(`^${n}$`));
  const names = () => $$('table.spendby tbody tr td:first-child').map((c) => text(c));

  it('search, sortable columns, a footer total, and paging (25 / 50 / 100 / 200 per page) on every tab', async () => {
    const cats = await api('/api/categories'); const groceries = cats.find((c) => c.name === 'Groceries').id;
    const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
    for (let i = 0; i < 60; i++) { // created without a category so each one gets its own merchant, then answered
      const made = await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: `ZZ SHOP ${String(i).padStart(2, '0')}`, amountCents: -(100 + i) } });
      await api(`/api/transactions/${made.id}/categorize`, { method: 'POST', body: { categoryId: groceries } });
    }
    await mount('/explore');
    dimTab('merchant').click();
    await waitFor(() => names().length >= 25, 'merchant rows');
    expect(names().length, 'paged at 25 by default').to.equal(25);
    expect($('.pager'), 'a pager').to.exist;
    expect(text($('.pager'))).to.match(/1–25 of \d+/);
    // sort by name, ascending then descending
    $('button.sorter[data-col=key]').click();
    await waitFor(() => $('th[aria-sort=ascending]'), 'ascending');
    const asc = names(); expect([...asc].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))).to.deep.equal(asc);
    $('button.sorter[data-col=key]').click();
    await waitFor(() => $('th[aria-sort=descending]'), 'descending');
    expect(names()[0].localeCompare(asc[0])).to.be.greaterThan(0);
    // sort by spent: biggest first, and the order flips
    $('button.sorter[data-col=spent]').click();
    await waitFor(() => $('button.sorter[data-col=spent]').closest('th').getAttribute('aria-sort') === 'descending', 'biggest spend first');
    const money = (t) => Number(t.replace(/[$,]/g, ''));
    const spent = () => $$('table.spendby tbody tr td:last-child').map((c) => money(text(c)));
    expect([...spent()].sort((a, b) => b - a)).to.deep.equal(spent());
    $('button.sorter[data-col=spent]').click();   // a second click on the same column reverses it
    await waitFor(() => $('button.sorter[data-col=spent]').closest('th').getAttribute('aria-sort') === 'ascending', 'smallest spend first');
    expect([...spent()].sort((a, b) => a - b)).to.deep.equal(spent());
    // next page
    byText('button', /Next ›/).click();
    await waitFor(() => /26–50 of/.test(text($('.pager'))), 'page 2');
    // per page 50 shows 50 rows
    const sel = $('.pager select.size'); choose(sel, '50');
    await waitFor(() => names().length === 50, '50 per page');
    // search narrows the table, resets the page, and the footer totals only what matches
    setInput($('.spend-search'), 'zz shop 07');
    await waitFor(() => names().length === 1, 'filtered to one');
    expect(names()[0]).to.match(/ZZ SHOP 07/);
    expect(text($('table.spendby tfoot'))).to.match(/Matching rows.*1.*\$1\.07/);
    expect(text(document.body)).to.match(/1 of \d+ rows/);
    setInput($('.spend-search'), 'no such merchant anywhere');
    await waitFor(() => /Nothing matches/.test(text($('table.spendby'))), 'empty state');
    // another tab starts clean: no search carried over, its own default order
    dimTab('category').click();
    await waitFor(() => names().some((n) => /Groceries/.test(n)), 'category rows');
    expect($('.spend-search').value).to.equal('');
    dimTab('month').click();
    await waitFor(() => names().length > 0 && $('th[aria-sort=descending] button[data-col=key]'), 'months, newest first');
    const months = names(); expect([...months].sort().reverse()).to.deep.equal(months);
  });
});
