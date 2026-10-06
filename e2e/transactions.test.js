import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, pickCat, api } from './helpers.js';

describe('Transactions', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  const rowFor = (re) => $$('tbody tr').find((r) => re.test(text(r)));

  it('lists, searches, and opens a transaction', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    const search = $('input[type=search]');
    setInput(search, 'SAFEWAY', 'change');
    await waitFor(() => $$('tbody tr').length === 1 && /SAFEWAY/.test(text($('tbody'))), 'search to narrow');
    rowFor(/SAFEWAY/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'detail dialog');
    expect(text(dlg)).to.match(/Splits/);
    expect(text(dlg)).to.match(/decided by rule/);
  });

  it('refuses splits that do not add up, then saves a valid 2-way split', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    rowFor(/SAFEWAY/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    byText('button', /＋ split/, dlg).click();
    await waitFor(() => $$('hk-category-select', dlg).length === 2, 'second split row');
    await pickCat($$('hk-category-select', dlg)[1], 'Eating Out');
    // first row amount stays at the full -$84.12; second row is $0.00 -> remaining is 0 so valid; make it invalid
    const amounts = () => $$('input', dlg).filter((i) => /^-?\d/.test(i.value));
    setInput(amounts()[1], '10.00', 'change');
    await waitFor(() => /remaining/.test(text(dlg)), 'remaining counter');
    byText('button', /^Save$/, dlg).click();
    await waitFor(() => /Splits must equal the amount/.test(text($('dialog[open]'))), 'validation error');
    // fix: 50/50 helper
    byText('button', /Even \(2-way\)/, $('dialog[open]')).click();
    byText('button', /^Save$/, $('dialog[open]')).click();
    await waitFor(() => !$('dialog[open]'), 'dialog to close');
    const t = (await api('/api/transactions?q=SAFEWAY'))[0];
    expect(t.splits).to.have.length(2);
    expect(t.splits.reduce((a, s) => a + s.amount_cents, 0)).to.equal(t.amount_cents);
  });

  it('hiding keeps the row recoverable', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    rowFor(/CHIPOTLE/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    byText('button', /^Hide$/, dlg).click();
    await waitFor(() => !rowFor(/CHIPOTLE/), 'row to disappear');
    $('input[type=checkbox][class=""], label input[type=checkbox]').click(); // "Show hidden"
    await waitFor(() => rowFor(/CHIPOTLE/), 'hidden row visible');
    rowFor(/CHIPOTLE/).click();
    const d2 = await waitFor(() => $('dialog[open]'), 'dialog again');
    byText('button', /^Restore$/, d2).click();
    await waitFor(async () => (await api('/api/transactions?q=CHIPOTLE'))[0]?.kind !== 'ignored', 'restored');
  });

  it('bulk-sets a category on selected rows', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    const rows = $$('tbody tr').filter((r) => /SEPHORA|NEW CAFE/.test(text(r)));
    expect(rows.length).to.be.greaterThan(0);
    rows.forEach((r) => { const cb = $('input[type=checkbox]', r); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
    const bar = await waitFor(() => $$('.card').find((c) => /selected/.test(text(c))), 'bulk bar');
    await pickCat($('hk-category-select', bar), 'Eating Out');
    await waitFor(async () => (await api('/api/transactions?q=SEPHORA')).every((t) => t.splits[0]?.category === 'Eating Out'), 'bulk applied');
  });

  it('Assign items: proposes a split of an Amazon order that adds up to the charge, with the item rule pre-selected', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    rowFor(/AMAZON/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    $('#assign-items', dlg).click();
    await waitFor(() => $$('hk-category-select', dlg).length === 2 && /Items allocated/.test(text(dlg)), 'item split rows');
    const sels = $$('hk-category-select', dlg);
    expect($('input', sels[0]).value).to.equal('Pets'); // "cat litter" rule
    byText('button', /^Save$/, dlg).click(); // second item has no category yet: the save still must add up, categories can stay blank
    await waitFor(() => !$('dialog[open]') || /error/i.test(text($('dialog[open]'))), 'saved');
    const t = (await api('/api/transactions?q=AMZN'))[0];
    expect(t.splits.reduce((a, s) => a + s.amount_cents, 0)).to.equal(t.amount_cents);
    expect(t.splits).to.have.length(2);
  });

  it('an ambiguous Venmo charge shows the candidate notes; one tap picks it', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    rowFor(/VENMO PAYMENT/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    await waitFor(() => $$('.pick-note', dlg).length === 2, 'two candidate notes');
    $$('.pick-note', dlg)[0].click();
    await waitFor(async () => (await api('/api/transactions?q=VENMO%20PAYMENT%20261001'))[0].note_state === 'user_provided', 'note chosen');
  });

  it('the detail dialog opens on top of the page, centered in view, not at the bottom', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    window.scrollTo(0, document.body.scrollHeight);
    rowFor(/SAFEWAY/)?.click() ?? $$('tbody tr')[3].click();
    const dlg = await waitFor(() => $('dialog.txn-detail[open]'), 'dialog');
    expect(dlg.matches(':modal')).to.equal(true);
    const r = dlg.getBoundingClientRect();
    expect(r.top).to.be.at.least(0); expect(r.bottom).to.be.at.most(window.innerHeight + 1);
    expect(Math.abs((r.left + r.right) / 2 - window.innerWidth / 2)).to.be.below(3); // centered, not pinned to a corner
    const mid = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(40, r.height / 2));
    expect(dlg.contains(mid)).to.equal(true); // nothing from the page is above it
    byText('button', /^Close$/, dlg).click();
  });

  it('pages through every transaction with working controls and a true total', async () => {
    const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
    for (let i = 0; i < 130; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: `PAGING TEST ${String(i).padStart(3, '0')}`, amountCents: -(100 + i) } });
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').length > 5, 'rows');
    const total = (await api('/api/transactions/count')).total;
    expect(total).to.be.greaterThan(60);
    expect(text($('.pager'))).to.match(new RegExp(`of ${total.toLocaleString()}`));
    const first = text($$('tbody tr')[0]);
    expect($('.pager .prev').disabled).to.equal(true);
    $('.pager .next').click();
    await waitFor(() => text($$('tbody tr')[0]) !== first, 'page 2');
    expect(text($('.pager'))).to.match(/51–100/);
    expect($('.pager .prev').disabled).to.equal(false);
    setInput($('.pager input.jump'), '1', 'change');
    await waitFor(() => text($$('tbody tr')[0]) === first, 'back to page 1');
    $('.pager .last').click();
    await waitFor(() => $('.pager .next').disabled === true, 'last page');
    expect($$('tbody tr').length).to.equal(total % 50 || 50);
    const size = $('.pager select.size'); size.value = '25'; size.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $$('tbody tr').length === 25, 'page size 25');
  });
});
