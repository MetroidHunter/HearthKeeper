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
    const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r))), 'Groceries row');
    expect(text($('.keeps', row))).to.equal('keeps $800.00'); // $800 monthly budget, empty cushion = 0
    const util = $$('tbody tr').find((r) => /Utilities/.test(text(r)));
    expect(text($('.never', util)), 'a non-discretionary envelope never gives').to.equal('never gives'); expect($('.keeps', util)).to.not.exist; expect($('input[aria-label="Cushion above the budget"]', util).disabled).to.equal(true);
    const head = $$('thead th').find((t) => /Cushion/.test(text(t)));
    expect($$('.keeps').length, 'every discretionary expense envelope shows what it keeps').to.be.greaterThan(3);
    expect(head.dataset.tip).to.match(/Discretionary envelopes only.*ABOVE this month's budget.*\$150 budget and a \$50 cushion.*more than \$200/);
  });
});

describe('The yearly amount never pushes the Budget table out of line', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); const { setViewport } = await import('@web/test-runner-commands'); await setViewport({ width: 800, height: 600 }); });
  it('the pencil stays beside the target, and every row keeps one line of height, even with a long yearly figure', async () => {
    const { api } = await import('./helpers.js'); const { setViewport } = await import('@web/test-runner-commands'); await setViewport({ width: 1280, height: 900 }); // a desktop window, as in the screenshot
    const cats = await api('/api/categories'); const g = cats.find((c) => c.name === 'Groceries');
    await api(`/api/categories/${g.id}/budget`, { method: 'POST', body: { monthlyCents: 123456789, effectiveMonth: new Date().toISOString().slice(0, 7) } }); // $1,234,567.89 a month
    await mount('/budget');
    const rows = await waitFor(() => { const r = $$('tbody tr.clickable'); return r.length > 3 && r; }, 'rows');
    const heights = new Set();
    for (const r of rows) {
      const tgt = $('.tgt', r).getBoundingClientRect(), pen = $('button.edit', r).getBoundingClientRect();
      expect(pen.top, `${text($('b', r))}: pencil is level with the target`).to.be.lessThan(tgt.bottom); expect(pen.bottom).to.be.greaterThan(tgt.top);
      expect(pen.left, 'pencil is to the right of the amount').to.be.at.least(tgt.right - 1);
      if ($('.yearly', r)) heights.add(Math.round(r.getBoundingClientRect().height)); // rows with no budget have no second line, so only compare rows that show one
    }
    const gro = rows.find((r) => /Groceries/.test(text(r)));
    expect(text($('.yearly', gro))).to.match(/\$14,814,814\.68 a year/);
    expect(Math.max(...heights) - Math.min(...heights), `rows are all about the same height: ${JSON.stringify(rows.map((r) => [text($('b', r)), Math.round(r.getBoundingClientRect().height), !!$('.yearly', r)]))} viewport ${innerWidth}`).to.be.at.most(6);
  });
});
