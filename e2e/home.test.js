import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api } from './helpers.js';

describe('Home (phone view)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows what needs you, favorites and recent transactions', async () => {
    await mount('/');
    await waitFor(() => $$('.card').length > 3, 'cards');
    expect(text($('h1'))).to.equal('Home');
    expect(byText('h2', /^Needs you/)).to.exist;
    expect(byText('h2', /^Favorites/)).to.exist;
    expect(byText('h2', /^Recent/)).to.exist;
  });

  it('one tap on the suggested category answers a prompt and clears it from Needs you', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card').find((c) => /SEPHORA|NEW CAFE|AMZN|MORTGAGE|SEQUOIA/i.test(text(c)) && $('button.chip', c)), 'a needs-you card with suggestions');
    const before = Number(/Needs you \((\d+)/.exec(text(byText('h2', /^Needs you/)))[1]);
    const name = text($('b', card));
    const chip = $('button.chip', card);
    chip.click();
    await waitFor(() => Number(/Needs you \((\d+)/.exec(text(byText('h2', /^Needs you/)))[1]) === before - 1, 'needs-you count to drop');
    const inbox = await api('/api/inbox');
    expect(inbox.needsCategory.map((t) => t.descriptor_clean || t.descriptor_raw)).to.not.include(name);
  });

  it('"Not a budget item" hides a transaction without deleting it', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card').find((c) => $('button:not(.chip)', c) && /Not a budget item/.test(text(c))), 'a card');
    const id = (await api('/api/inbox')).needsCategory.length;
    byText('button', /Not a budget item/, card).click();
    await waitFor(async () => (await api('/api/inbox')).needsCategory.length === id - 1, 'inbox to shrink');
    const hidden = await api('/api/transactions?hidden=1&kind=ignored');
    expect(hidden.length).to.be.greaterThan(0);
  });

  it('quick add creates a categorized transaction that appears under Recent', async () => {
    await mount('/');
    byText('button', /Add/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'quick add dialog');
    const [desc, amt] = $$('input', dlg);
    desc.value = 'E2E COFFEE'; desc.dispatchEvent(new Event('input', { bubbles: true }));
    amt.value = '4.50'; amt.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = $$('select', dlg)[0];
    sel.value = [...sel.options].find((o) => /Eating Out/.test(text(o))).value; sel.dispatchEvent(new Event('change', { bubbles: true }));
    byText('button', /^Save$/, dlg).click();
    await waitFor(() => /E2E COFFEE/.test(text(byText('h2', /^Recent/).nextElementSibling)), 'new row under Recent');
  });
});
