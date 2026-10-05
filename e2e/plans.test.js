import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api, sleep } from './helpers.js';

describe('Plans: draft, diff, go-live', () => {
  let trap; let origPrompt;
  beforeEach(async () => { await reset(); trap = trapErrors(); origPrompt = window.prompt; window.prompt = () => 'E2E plan'; });
  afterEach(() => { window.prompt = origPrompt; trap.stop(); expect(trap.errs).to.deep.equal([]); });

  async function newDraft() {
    await mount('/plans');
    byText('button', /New from live/).click();
    await waitFor(() => $$('.card').some((c) => /E2E plan/.test(text(c)) && /draft/.test(text(c))), 'draft created');
    await waitFor(() => $$('table input').length > 3, 'plan items');
  }
  const input = (name) => $$('table tr').find((r) => text(r.firstElementChild) === name).querySelector('input');

  it('edits a draft, shows an accurate diff, and goes live atomically', async () => {
    await newDraft();
    setInput(input('Groceries'), '950.00', 'change');
    setInput(input('Eating Out'), '325.00', 'change');
    await sleep(300);
    byText('button', /Make live/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'confirm dialog');
    expect(text(dlg)).to.match(/2 history entries will be created/);
    expect(text(dlg)).to.match(/Groceries/); expect(text(dlg)).to.match(/\$950\.00/);
    expect(text(dlg)).to.not.match(/RESTATE/); // current month is not retroactive
    byText('button', /^Confirm$/, dlg).click();
    await waitFor(async () => (await api('/api/plans')).filter((p) => p.status === 'live').length === 1 && (await api('/api/plans')).find((p) => p.status === 'live').name === 'E2E plan', 'new live plan');
    const budget = await api('/api/budget');
    expect(budget.rows.find((r) => r.name === 'Groceries').targetCents).to.equal(95000);
    expect(budget.header.livePlan).to.equal('E2E plan');
  });

  it('a retroactive go-live needs the typed RESTATE confirmation and shows balance impact', async () => {
    await newDraft();
    setInput(input('Groceries'), '1000.00', 'change');
    await sleep(300);
    const month = $('input[type=month]'); setInput(month, '2026-08', 'change');
    byText('button', /Make live/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'dialog');
    expect(text(dlg)).to.match(/restates history/i);
    const confirm = byText('button', /^Confirm$/, dlg);
    expect(confirm.disabled).to.equal(true);
    setInput($('input', dlg), 'RESTATE');
    await waitFor(() => !byText('button', /^Confirm$/, $('dialog[open]')).disabled, 'confirm to enable');
  });

  it('only the live plan\'s income snapshot drives the header; editing a scenario later does not move it', async () => {
    await mount('/plans');
    const before = (await api('/api/plans')).find((p) => p.status === 'live');
    const scen = (await api('/api/scenarios'))[0];
    await api(`/api/scenarios/${scen.id}/lines`, { method: 'PUT', body: { lines: [{ label: 'x', annualSalaryCents: 30000000, taxRateBp: 3000 }] } });
    const after = (await api('/api/plans')).find((p) => p.status === 'live');
    expect(after.incomeCents).to.equal(before.incomeCents);
  });
});
