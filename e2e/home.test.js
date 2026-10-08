import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, pickCat, confirmDialog, setInput, openAll } from './helpers.js';

describe('Home (phone view)', () => {
  let trap;
  beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '1'); trap = trapErrors(); }); // Needs attention starts collapsed; most tests need it open
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('orders the page: Needs attention (collapsible) first, Favorites second, then Recent, and Add transaction last, with no intro text', async () => {
    await mount('/');
    await waitFor(() => $$('.trow.txn').length > 2 && $$('.fav').length > 0, 'rows and favorites');
    expect(text($('h1'))).to.equal('Home');
    expect($('.intro')).to.not.exist; // the explanation block is gone from Home
    const heads = $$('h2').map((h) => text(h));
    expect(heads).to.deep.equal(['Needs attention', 'Favorites', 'Recent']);
    const page = $('main').firstElementChild;
    const kids = [...page.children];
    const idx = (pred) => kids.findIndex(pred);
    expect(idx((k) => k.matches('details.fold'))).to.be.lessThan(idx((k) => /^Favorites/.test(text(k))));
    expect(idx((k) => /^Favorites/.test(text(k)))).to.be.lessThan(idx((k) => /^Recent/.test(text(k))));
    const last = kids.at(-1);
    expect(byText('button', /Add transaction/, last)).to.exist; // add transaction is the very last thing
    const inbox = await api('/api/inbox');
    expect(text($('details.fold'))).to.match(new RegExp(`${inbox.counts.total} item`)); // the headline count is the true count
    expect($('.trow.txn[data-cat=missing]', $('details.fold'))).to.exist; // a missing category is a dropdown in the row
  });

  it('Needs attention starts collapsed, opens on tap, and the choice is remembered', async () => {
    localStorage.removeItem('hk-home-attention-open'); // a fresh device
    await mount('/');
    const fold = await waitFor(() => $('details.fold'), 'the fold');
    expect(fold.open).to.equal(false); // collapsed by default
    expect($('.trow.txn', fold).checkVisibility()).to.equal(false);
    expect(text($('summary', fold))).to.match(/Needs attention\s*\d+/); // the count is still visible while collapsed
    $('summary', fold).click();
    await waitFor(() => fold.open && localStorage.getItem('hk-home-attention-open') === '1', 'opened and saved');
    expect($('.trow.txn', fold).checkVisibility()).to.equal(true);
    await mount('/');
    expect($('details.fold').open).to.equal(true); // still open on the next visit
    $('summary', $('details.fold')).click();
    await waitFor(() => !$('details.fold').open && localStorage.getItem('hk-home-attention-open') === '0', 'collapsed again');
  });

  it('favorites are compact tiles that still carry name, balance, pace bar and spent of target', async () => {
    await mount('/');
    const tile = await waitFor(() => $('.favs .fav'), 'a favorite');
    expect($('.fav-name', tile).textContent.length).to.be.greaterThan(1);
    expect(text($('.fav-bal', tile))).to.match(/^-?\$[\d,]+\.\d\d$/);
    expect($('.bar', tile)).to.exist;
    expect(text($('.fav-sub', tile))).to.match(/\$[\d,.]+ of \$[\d,.]+/);
    expect(tile.getBoundingClientRect().height).to.be.below(130);
  });

  it('shows the whole transaction line and the transactions around it', async () => {
    await mount('/');
    const card = await waitFor(() => $('.trow.txn'), 'a needs-you row');
    expect($('.txn-line', card)).to.exist; // the bank's line is in the details
    expect($('.tmore', card).checkVisibility(), 'folded until you open Details').to.equal(false);
    $('.texpand', card).click();
    expect($('.tmore', card).checkVisibility()).to.equal(true);
    byText('button', /Show nearby transactions/, card).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && $('.ctx-row.target', d)), 'context dialog');
    expect($$('.ctx-row', dlg).length).to.be.greaterThan(1);
    byText('button', /^Close$/, dlg).click();
  });

  it('picking a suggestion asks first and shows the budget change; Yes saves, Cancel does not', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.trow.txn').find((c) => $('button.quick', c)), 'a needs-you card with suggestions');
    const name = text($('.tdesc', card));
    const before = (await api('/api/inbox')).counts.needsCategory;
    const opt = $('button.quick', card);
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
    const card = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row with a category dropdown');
    const picker = $('.tcat hk-category-select', card);
    await pickCat(picker, 'Gas');
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as Gas/.test(text(d))), 'confirm dialog for Gas');
    byText('button', /^Cancel$/, dlg).click();
  });

  it('"Not a budget item" hides a transaction without deleting it', async () => {
    await mount('/');
    const card = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row');
    const n = (await api('/api/inbox')).counts.needsCategory;
    $('.texpand', card).click();
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

  it('picking from the search box and confirming saves it, with no page errors', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((c) => !/GREENLIGHT/i.test(text(c))), 'a card waiting for a category');
    const id = Number(card.dataset.id);
    await pickCat($('.tcat hk-category-select', card), 'Gas');
    await confirmDialog(/Yes, categorize/);
    await waitFor(() => !$$('.trow.txn').some((c) => Number(c.dataset.id) === id && c.dataset.cat === 'missing'), 'the card to stop asking for a category');
    const t = (await api(`/api/transactions?limit=500`)).find((x) => x.id === id);
    expect(t.splits.map((s) => s.category)).to.deep.equal(['Gas']);
    expect(t.splits.reduce((a, s) => a + s.amount_cents, 0)).to.equal(t.amount_cents);
  });

  it('a failed save is shown in a dialog instead of failing silently', async () => {
    await mount('/');
    const card = await waitFor(() => $$('.trow.txn').find((c) => $('button.quick', c)), 'a card');
    const real = window.fetch;
    window.fetch = (u, o) => (/\/categorize/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ error: 'Period is closed' }), { status: 409, headers: { 'content-type': 'application/json' } })) : real(u, o)); // the server refuses
    try {
      $('button.quick', card).click();
      await confirmDialog(/Yes, categorize/);
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /did not save/.test(text(d))), 'error dialog');
      expect(text(dlg)).to.match(/Period is closed/); expect(text(dlg)).to.match(/Nothing was changed/);
      byText('button', /^OK$/, dlg).click();
    } finally { window.fetch = real; }
  });

  it('a transaction with more than one open reason stays after the category is set, shows what was decided, and leaves once the note is dealt with', async () => {
    await mount('/');
    const venmo = () => $$('.trow.txn').find((c) => /VENMO PAYMENT/i.test(text(c)));
    const row = await waitFor(venmo, 'the Venmo row');
    expect(row.dataset.cat).to.equal('missing'); expect(row.dataset.note).to.equal('missing');
    expect($('.tcat hk-category-select', row), 'dropdown in the Category cell').to.exist;
    expect($('.tnote input.note-input', row), 'input in the Note cell').to.exist;
    expect($('.tnote button.note-pick', row)).to.exist; expect($('.tnote button.note-none', row)).to.exist; // icon buttons for the matcher and "none"
    await pickCat($('.tcat hk-category-select', row), 'Eating Out');
    await confirmDialog(/Yes, categorize/);
    await waitFor(() => { const c = venmo(); return c && c.dataset.cat === 'ok' && /Eating Out/.test(text($('.tcat', c))); }, 'the row to show the category and drop that reason');
    expect(venmo().dataset.note).to.equal('missing'); // still waiting on the note: that is why it did not leave
    expect(text($$('.toast').at(-1))).to.match(/Categorized as Eating Out/); // and the save was confirmed on screen
    $('button.note-none', venmo()).click();
    await waitFor(() => !venmo(), 'the row to leave once nothing is open');
  });

  it('flagged and never-posted items have their own way out', async () => {
    const accts = await api('/api/accounts'); const chase = accts.find((a) => a.name === 'Chase Prime Visa').id;
    const created = await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'FLAGGED THING', amountCents: -777, categoryId: (await api('/api/categories')).find((c) => c.name === 'Gas').id } });
    await api(`/api/transactions/${created.id}`, { method: 'PATCH', body: { flagged: 1, flagReason: 'check this' } });
    await mount('/');
    const card = await waitFor(() => $$('.trow.txn').find((c) => /FLAGGED THING/.test(text(c))), 'the flagged card');
    expect(text($('.chip[data-flag]', card))).to.match(/check this/);
    $('button.unflag', card).click();
    await waitFor(() => !$$('.trow.txn').some((c) => /FLAGGED THING/.test(text(c))), 'card to leave after Mark as reviewed');
  });

  it('rows use the Transactions table\'s columns in order (Date, Description, Amount, Category, Note), two lines high, with the account and raw details behind Details', async () => {
    await mount('/');
    const row = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row with a missing category');
    const cells = [...$('.tcells', row).children].map((c) => c.className);
    expect(cells).to.deep.equal(['tdate', 'tdesc', 'tamt', 'tcat', 'tnote']);
    const head = [...$('.trow.thead .tcells').children].map((c) => text(c));
    expect(head).to.deep.equal(['Date', 'Description', 'Amount', 'Category', 'Note']);
    const xs = ['.tdate', '.tdesc', '.tamt', '.tcat', '.tnote'].map((s) => $(s, row).getBoundingClientRect().left);
    expect([...xs].sort((a, b) => a - b), 'laid out left to right in that order').to.deep.equal(xs);
    expect($('.tsub .texpand', row), 'the thin second line').to.exist;
    expect($('.tsub', row).getBoundingClientRect().top).to.be.at.least($('.tcells', row).getBoundingClientRect().bottom - 1);
    expect(row.getBoundingClientRect().height, 'two lines, not a card').to.be.below(130);
    expect(text($('.tmore', row))).to.match(/Chase|Wells|Greenlight/); // the account lives in the details
    expect(text($('.tcells', row))).to.not.match(/Chase Prime|Wells Fargo|Greenlight wallet/);
  });

  it('a note can be typed into the row, shows on it, and appears in the Transactions list', async () => {
    await mount('/');
    const row = await waitFor(() => $$('.trow.txn').find((c) => c.dataset.note === 'missing'), 'a row waiting on a note');
    const id = row.dataset.id;
    const input = $('.tnote input.note-input', row);
    setInput(input, 'birthday gift for Sam'); input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(async () => (await api(`/api/transactions?q=birthday`)).some((t) => t.note === 'birthday gift for Sam'), 'note saved');
    await mount('/transactions');
    await waitFor(() => $$('tbody tr').some((r) => /birthday gift for Sam/.test(text(r))), 'the note column');
    expect($$('thead th').map((t) => text(t))).to.include('Note');
    expect($$('thead th').map((t) => text(t))).to.not.include('Account');
    expect($$('thead th').map((t) => text(t)).filter(Boolean)).to.deep.equal(['Date', 'Description', 'Amount', 'Category', 'Note', 'Flag']); // the same order as the rows on Home, then the flag button
    expect(id).to.exist;
  });
});
