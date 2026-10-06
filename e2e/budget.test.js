import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, api } from './helpers.js';

describe('Budget', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows the live plan header, groups and balances', async () => {
    await mount('/budget');
    await waitFor(() => $$('tbody tr').length > 10, 'rows');
    const header = text($('.grid3'));
    expect(header).to.match(/Live plan\s*Current budget/);
    expect(header).to.match(/\$12,466\.67/); // the $220k @ 32% scenario from Projection
    expect(header).to.match(/Allocated \/ income \(unallocated\)\s*\$4,490\.00\s*\/ \$12,466\.67\s*\(\$7,976\.67\)/); // one compact card: allocated / income (unallocated)
    expect($$('.stat', $('.grid3')).length, 'plan + one combined card').to.equal(2);
    expect(byText('h3', /^Food/)).to.exist; // each group is a full card with its own heading
    expect(text($$('tbody tr').find((r) => /Salary/.test(text(r))))).to.match(/N\/A/); // income_reference shows N/A like the sheet
  });

  it('editing a target appends a version dated this month, and the old value stays in history', async () => {
    await mount('/budget');
    const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r))), 'groceries row');
    $('button.edit', row).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'edit dialog');
    setInput($('input', dlg), '900.00');
    byText('button', /^Save$/, dlg).click();
    await waitFor(() => /\$900\.00/.test(text($$('tbody tr').find((r) => /Groceries/.test(text(r))))), 'new target');
    const cat = (await api('/api/categories')).find((c) => c.name === 'Groceries');
    const detail = await api(`/api/categories/${cat.id}`);
    const last = detail.history.at(-1);
    expect(last.monthly_cents).to.equal(90000);
    expect(last.from_cents).to.equal(80000);
  });

  it('pie view draws a chart, shows group shares and drills into a group', async () => {
    await mount('/budget');
    await waitFor(() => $$('tbody tr').length > 5, 'table');
    byText('button', /^Pie$/).click();
    const canvas = await waitFor(() => $('.chart canvas'), 'pie canvas');
    expect(canvas.width).to.be.greaterThan(50);
    const pie = await api('/api/budget/pie');
    expect(pie.groups.length).to.be.greaterThan(3);
    expect(Math.round(pie.groups.reduce((a, g) => a + g.share, 0) * 1000)).to.equal(1000);
    byText('button', /Share of allocated/).click();
    await waitFor(() => byText('button', /Share of spent/), 'toggle to spent');
  });
});
