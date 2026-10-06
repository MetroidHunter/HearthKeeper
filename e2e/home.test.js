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
    const why = await waitFor(() => $('.why'), 'a why line');
    expect(text(why)).to.match(/Needs a (category|note)|Flagged|Never posted/);
    expect(text(why.closest('.card'))).to.match(/Why this needs you/);
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

  it('picking from the search box and confirming saves it, with no page errors, including for a Greenlight spend', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card.txn').find((c) => /El Rinconsito|Greenlight wallet/i.test(text(c))), 'the Greenlight spend card');
    const id = Number(card.dataset.id);
    const before = (await api('/api/budget')).rows.find((r) => r.name === 'Gas');
    await pickCat($('hk-category-select', card), 'Gas');
    await confirmDialog(/Yes, categorize/);
    await waitFor(() => !$$('.card.txn').some((c) => Number(c.dataset.id) === id), 'the card to leave Needs you');
    const t = (await api(`/api/transactions?q=Rinconsito`))[0];
    const gas = t.splits.find((s) => s.category === 'Gas');
    expect(gas, 'a Gas split').to.exist;
    expect(gas.amount_cents).to.be.below(0); // the spend now sits in Gas
    expect(t.splits.reduce((a, s) => a + s.amount_cents, 0)).to.equal(0); // and the child's category got it back
    const after = (await api('/api/budget')).rows.find((r) => r.name === 'Gas');
    expect(after.currentCents).to.be.below(before.currentCents);
  });

  it('a failed save is shown in a dialog instead of failing silently', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.card.txn').find((c) => $('button.option', c)), 'a card');
    const real = window.fetch;
    window.fetch = (u, o) => (/\/categorize/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ error: 'Period is closed' }), { status: 409, headers: { 'content-type': 'application/json' } })) : real(u, o)); // the server refuses
    try {
      $('button.option', card).click();
      await confirmDialog(/Yes, categorize/);
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /did not save/.test(text(d))), 'error dialog');
      expect(text(dlg)).to.match(/Period is closed/); expect(text(dlg)).to.match(/Nothing was changed/);
      byText('button', /^OK$/, dlg).click();
    } finally { window.fetch = real; }
  });

  it('a transaction with more than one open reason stays after the category is set, shows what was decided, and leaves once the note is dealt with', async () => {
    await mount('/');
    const venmo = () => $$('.card.txn').find((c) => /VENMO PAYMENT/i.test(text(c)));
    const card = await waitFor(venmo, 'the Venmo card');
    expect(text(card)).to.match(/Needs a category/); expect(text(card)).to.match(/Needs a note/);
    expect($('button.note-none', card)).to.exist;
    await pickCat($('hk-category-select', card), 'Eating Out');
    await confirmDialog(/Yes, categorize/);
    await waitFor(() => { const c = venmo(); return c && /Category: Eating Out/.test(text(c)) && !/Needs a category/.test(text(c)); }, 'the card to show the category and drop that reason');
    expect(text(venmo())).to.match(/Needs a note/); // still waiting on the note: that is why it did not leave
    expect(text($$('.toast').at(-1))).to.match(/Categorized as Eating Out/); // and the save was confirmed on screen
    $('button.note-none', venmo()).click();
    await waitFor(() => !venmo(), 'the card to leave once nothing is open');
  });

  it('flagged and never-posted items have their own way out', async () => {
    const accts = await api('/api/accounts'); const chase = accts.find((a) => a.name === 'Chase Prime Visa').id;
    const created = await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'FLAGGED THING', amountCents: -777, categoryId: (await api('/api/categories')).find((c) => c.name === 'Gas').id } });
    await api(`/api/transactions/${created.id}`, { method: 'PATCH', body: { flagged: 1, flagReason: 'check this' } });
    await mount('/');
    const card = await waitFor(() => $$('.card.txn').find((c) => /FLAGGED THING/.test(text(c))), 'the flagged card');
    expect(text(card)).to.match(/Flagged: Flagged for follow-up: check this/);
    $('button.unflag', card).click();
    await waitFor(() => !$$('.card.txn').some((c) => /FLAGGED THING/.test(text(c))), 'card to leave after Mark as reviewed');
  });
});
