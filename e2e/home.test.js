import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, pickCat, confirmDialog, setInput } from './helpers.js';

describe('Home (phone view)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('shows favorites first, then what needs you with a reason, then recent transactions', async () => {
    await mount('/');
    await waitFor(() => $$('.card').length > 3, 'cards');
    expect(text($('h1'))).to.equal('Home');
    const heads = $$('h2').map((h) => text(h));
    expect(heads.indexOf('Favorites')).to.be.greaterThan(-1);
    expect(heads.indexOf('Favorites')).to.be.lessThan(heads.indexOf('Needs you')); // favorites above needs-you
    expect(heads).to.include('Recent');
    expect($('.intro')).to.exist;
    const inbox = await api('/api/inbox');
    expect(text(byText('h2', /^Needs you/).nextElementSibling)).to.match(new RegExp(`${inbox.counts.total} item`)); // the headline count is the true count
    expect(inbox.needsCategory[0].why).to.be.a('string');
    expect(text(await waitFor(() => $('.why'), 'a why line'))).to.match(/Why this needs you/);
  });

  it('shows the whole transaction line and the transactions around it', async () => {
    await mount('/');
    const card = await waitFor(() => $('.card.txn'), 'a needs-you card');
    expect($('.txn-line', card)).to.exist;
    byText('button', /Show nearby transactions/, card).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && $('.ctx-row.target', d)), 'context dialog');
    expect($$('.ctx-row', dlg).length).to.be.greaterThan(1);
    byText('button', /^Close$/, dlg).click();
  });

  it('picking a suggestion asks first and shows the budget change; Yes saves, Cancel does not', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card.txn').find((c) => $('button.option', c)), 'a needs-you card with suggestions');
    const name = text($('b', card));
    const before = (await api('/api/inbox')).counts.needsCategory;
    const opt = $('button.option', card);
    opt.click();
    let dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'confirm dialog');
    expect(text(dlg)).to.match(/Balance now/); expect(text(dlg)).to.match(/Balance after/);
    byText('button', /^Cancel$/, dlg).click();
    await new Promise((r) => setTimeout(r, 150));
    expect((await api('/api/inbox')).counts.needsCategory).to.equal(before); // cancelling changed nothing
    opt.click();
    await confirmDialog(/Yes, categorize/);
    await waitFor(async () => (await api('/api/inbox')).counts.needsCategory === before - 1, 'inbox to shrink');
    expect((await api('/api/inbox')).needsCategory.map((t) => t.descriptor_clean || t.descriptor_raw)).to.not.include(name);
  });

  it('any category can be found by typing in the search box', async () => {
    await mount('/');
    const card = await waitFor(() => $('.card.txn'), 'a needs-you card');
    const picker = $('hk-category-select', card);
    await pickCat(picker, 'Gas');
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as Gas/.test(text(d))), 'confirm dialog for Gas');
    byText('button', /^Cancel$/, dlg).click();
  });

  it('"Not a budget item" hides a transaction without deleting it', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card.txn').find((c) => /Not a budget item/.test(text(c))), 'a card');
    const n = (await api('/api/inbox')).counts.needsCategory;
    byText('button', /Not a budget item/, card).click();
    await waitFor(async () => (await api('/api/inbox')).counts.needsCategory === n - 1, 'inbox to shrink');
    const hidden = await api('/api/transactions?hidden=1&kind=ignored');
    expect(hidden.length).to.be.greaterThan(0);
  });

  it('quick add creates a categorized transaction that appears under Recent', async () => {
    await mount('/');
    byText('button', /Add transaction/).click();
    const dlg = await waitFor(() => $('dialog[open]'), 'quick add dialog');
    const [desc, amt] = $$('input', dlg);
    desc.value = 'E2E COFFEE'; desc.dispatchEvent(new Event('input', { bubbles: true }));
    amt.value = '4.50'; amt.dispatchEvent(new Event('input', { bubbles: true }));
    await pickCat($('hk-category-select', dlg), 'Eating Out');
    byText('button', /^Save$/, dlg).click();
    await waitFor(() => /E2E COFFEE/.test(text(byText('h2', /^Recent/).nextElementSibling)), 'new row under Recent');
  });
});
