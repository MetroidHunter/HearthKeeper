import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput } from './helpers.js';

describe('Budgets show their yearly amount', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('the Budget table shows monthly × 12 under each target, and the edit dialog updates it as you type', async () => {
    await mount('/budget');
    const row = await waitFor(() => $$('tbody tr.clickable').find((r) => /Groceries/.test(text(r))), 'Groceries row');
    expect(text($('.yearly', row))).to.equal('$9,600.00 a year'); // the demo budget is $800 a month
    $('button.edit', row).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'edit dialog');
    expect(text($('.yearly-now', dlg))).to.match(/\$9,600\.00.*a year.*\$800\.00 × 12/);
    setInput($('input[aria-label="Monthly amount"]', dlg), '30');
    await waitFor(() => /\$360\.00.*a year.*\$30\.00 × 12/.test(text($('.yearly-now', dlg))), 'yearly total follows the typing');
    setInput($('input[aria-label="Monthly amount"]', dlg), 'abc');
    await waitFor(() => /Enter an amount/.test(text($('.yearly-now', dlg))), 'no number, no total');
  });

  it('adding a category shows what its monthly amount comes to in a year', async () => {
    await mount('/categories');
    const input = await waitFor(() => $('input[aria-label="Monthly amount"]'), 'the monthly box');
    expect($('.yearly-add')).to.not.exist;
    setInput(input, '30');
    await waitFor(() => /= \$360\.00 a year/.test(text($('.yearly-add'))), 'yearly hint');
  });

  it('the Categories page explains the cushion as "above the budget" and shows what each envelope keeps (budget + cushion)', async () => {
    await mount('/categories');
    const row = await waitFor(() => $$('tbody tr').find((r) => /Utilities/.test(text(r))), 'Utilities row');
    expect(text($('.keeps', row))).to.equal('keeps $350.00'); // $300 monthly budget + $50 cushion
    const head = $$('thead th').find((t) => /Cushion/.test(text(t)));
    expect($$('.keeps').length, 'every expense envelope shows what it keeps').to.be.greaterThan(5);
    expect(head.dataset.tip).to.match(/ABOVE this month's budget.*\$150 budget and a \$50 cushion.*more than \$200/);
  });
});
