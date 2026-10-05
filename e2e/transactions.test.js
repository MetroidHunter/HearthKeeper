import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api } from './helpers.js';

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
    await waitFor(() => $$('select', dlg).length === 2, 'second split row');
    choose($$('select', dlg)[1], 'Eating Out');
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
    choose($('select', bar), 'Eating Out');
    await waitFor(async () => (await api('/api/transactions?q=SEPHORA')).every((t) => t.splits[0]?.category === 'Eating Out'), 'bulk applied');
  });
});
