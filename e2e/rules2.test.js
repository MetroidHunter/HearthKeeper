import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, pickCat, confirmDialog, api, sleep } from './helpers.js';

describe('Rules are made while categorizing, with AND / OR conditions', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  const chaseId = async () => (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;

  it('the dialog has no "remember" box; ticking "Make a rule" opens a builder with a live backtest, AND and OR, and saves a rule of yours', async () => {
    const chase = await chaseId();
    await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'ZEBRA FEED STORE', amountCents: -2500 } });
    await mount('/backlog');
    const row = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((r) => /ZEBRA FEED/.test(text(r))), 'the row');
    await pickCat($('.tcat hk-category-select', row), 'Groceries');
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'confirm dialog');
    expect($('#remember', dlg), 'the learn checkbox is gone').to.not.exist;
    expect($('.ruleform', dlg), 'no rule form until asked').to.not.exist;
    $('#make-rule', dlg).click();
    await waitFor(() => $('.ruleform', dlg), 'rule form');
    expect($('.rf-value', dlg).value, 'seeded from the transaction').to.match(/ZEBRA FEED/i);
    // AND another condition, and an OR alternative inside the first clause
    byText('button', /and another condition/, dlg).click();
    await waitFor(() => $$('.rb-clause', dlg).length === 2, 'second clause');
    expect(text($('.rb-join.and', dlg))).to.equal('AND');
    expect($('button.primary.confirm', dlg).disabled, 'an empty condition blocks saving').to.equal(true);
    setInput($$('.rf-value', dlg)[1], 'feed');
    byText('button', /or another way/, $$('.rb-clause', dlg)[0]).click();
    await waitFor(() => $$('.rb-alt', dlg).length === 3, 'alternative added');
    expect(text($('.rb-join.or', dlg))).to.equal('OR');
    setInput($$('.rf-value', dlg)[1], 'zebra');       // the OR alternative of the first clause
    setInput($$('.rf-value', dlg)[2], 'feed store');  // the AND clause
    await waitFor(() => /would have matched \d+/i.test(text($('.rf-bt', dlg))), 'live backtest');
    $('.rf-mode', dlg).value = 'auto'; $('.rf-mode', dlg).dispatchEvent(new Event('change', { bubbles: true }));
    setInput($('.rf-pri', dlg), '25');
    expect(text($('button.primary.confirm', dlg))).to.match(/make the rule/);
    $('button.primary.confirm', dlg).click();
    await waitFor(async () => (await api('/api/rules')).some((r) => r.origin === 'user' && r.priority === 25 && r.mode === 'auto' && /any_of/.test(r.match_json) && /feed store/i.test(r.match_json)), 'rule saved with an OR group');
    const rule = (await api('/api/rules')).find((r) => /any_of/.test(r.match_json) && /feed store/i.test(r.match_json));
    const m = JSON.parse(rule.match_json).all_of;
    expect(m).to.have.length(2); expect(m[0].any_of).to.have.length(2); expect(m[1]).to.include({ value: 'feed store' });
    // the rule is shown on the Rules page as readable AND / OR
    await mount('/rules');
    await waitFor(() => $$('tbody tr').some((r) => / OR /.test(text(r)) && / AND /.test(text(r))), 'AND / OR shown');
  });

  it('without ticking it, answering creates no rule; the category picker empties itself after the dialog (confirmed or cancelled)', async () => {
    const chase = await chaseId(); const before = (await api('/api/rules')).length;
    for (let i = 0; i < 2; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'QUOKKA SUPPLY', amountCents: -(900 + i) } });
    await mount('/backlog');
    const group = await waitFor(() => $$('.group').find((c) => /QUOKKA/.test(text(c))), 'group');
    const picker = $('.bulkbar hk-category-select', group);
    await pickCat(picker, 'Groceries');
    byText('button', /^Cancel$/, await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'dialog')).click();
    await sleep(80);
    expect($('input', picker).value, 'cancelled: nothing left in the box').to.equal('');
    await pickCat(picker, 'Groceries'); await confirmDialog(/Yes, categorize/);
    await waitFor(() => /2 categorized/.test(text(document.body)), 'done');
    expect((await api('/api/rules')).length).to.equal(before);
    for (const input of $$('hk-category-select input')) expect(input.value, 'no picker keeps stale text').to.equal('');
  });

  it('a rule\'s answer and the merchant\'s usual answer are both offered, labelled, when they differ', async () => {
    const chase = await chaseId();
    const mk = (d, c) => api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: d, amountCents: c } });
    const first = await mk('PELICAN BAKERY', -500); const id1 = first.id;
    await api(`/api/transactions/${id1}/categorize`, { method: 'POST', body: { categoryId: (await api('/api/categories')).find((c) => c.name === 'Eating Out').id } });
    await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'pelican' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'suggest' } });
    await mk('PELICAN BAKERY', -600);
    await mount('/backlog');
    setInput(await waitFor(() => $('input[type=search]'), 'the search box'), 'PELICAN'); // the demo has more rows waiting now: look only at this merchant
    const row = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((r) => /PELICAN/.test(text(r))), 'row');
    const qs = $$('button.quick', row);
    expect(qs.map((q) => [q.dataset.why, text(q)])).to.deep.equal([['rule', 'Groceries'], ['merchant history', 'Eating Out']]); // no prefix: the category is what you read
    expect(qs.map((q) => q.title)).to.deep.equal(['Suggested by your rule', 'Suggested by what you usually choose for this merchant']);
    for (const q of qs) expect(q.scrollWidth, `"${text(q)}" is not clipped`).to.be.at.most(q.clientWidth + 1);
    expect($('.tcat', row).getBoundingClientRect().width, 'Category gets more room than Note').to.be.greaterThan($('.tnote', row).getBoundingClientRect().width * 1.5);
  });

  it('a merchant card stays where it is while you answer its rows one by one', async () => {
    const chase = await chaseId();
    for (let i = 0; i < 3; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'AAA BIG SHOP', amountCents: -(100 + i) } });
    for (let i = 0; i < 2; i++) await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'BBB SMALL SHOP', amountCents: -(200 + i) } });
    await mount('/backlog');
    const names = () => $$('.group').map((g) => text($('.grouphead b', g)));
    await waitFor(() => names().includes('AAA BIG SHOP') && names().includes('BBB SMALL SHOP'), 'both groups');
    const order = names(); const big = $$('.group').find((g) => /AAA BIG SHOP/.test(text(g)));
    // answer two of the big merchant's rows alone: it now has fewer than the small one
    for (let i = 0; i < 2; i++) {
      const g = $$('.group').find((x) => /AAA BIG SHOP/.test(text($('.grouphead b', x))));
      const r = $$('.trow.txn[data-cat=missing]', g)[0];
      await pickCat($('.tcat hk-category-select', r), 'Groceries'); await confirmDialog(/Yes, categorize/);
      await waitFor(() => !document.querySelector('dialog.busy[open]'), 'saved');
    }
    await sleep(200);
    expect(names().filter((n) => order.includes(n)), 'same order as before').to.deep.equal(order.filter((n) => names().includes(n)));
    expect(names().indexOf('AAA BIG SHOP')).to.be.lessThan(names().indexOf('BBB SMALL SHOP'));
    expect(big).to.exist;
  });
});

describe('Rules page: New rule, with amount conditions', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('"New rule" is on the Rules tab; amount (exactly / at least / at most / between) and direction are conditions; the rule saves and reads back', async () => {
    await mount('/rules');
    await waitFor(() => $$('tbody tr').length > 2, 'rules');
    const before = (await api('/api/rules')).length;
    byText('button', /New rule/).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /New rule/.test(text($('h3', d) ?? d))), 'dialog');
    expect($('button.rf-save', dlg).disabled, 'nothing filled in').to.equal(true);
    setInput($('.rf-value', dlg), 'qantas');
    byText('button', /and another condition/, dlg).click();
    await waitFor(() => $$('.rb-clause', dlg).length === 2, 'clause 2');
    const sel = $$('.rf-field', dlg)[1]; sel.value = 'amount'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $('.rf-op', dlg), 'amount comparison');
    expect($$('.rf-op option', dlg).map((o) => text(o))).to.deep.equal(['is exactly', 'is at least', 'is at most', 'is between']);
    const op = $('.rf-op', dlg); op.value = 'between'; op.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $('.rf-value2', dlg), 'second amount box');
    setInput($('.rf-money', dlg), '50'); setInput($('.rf-value2', dlg), '20');
    expect($('button.rf-save', dlg).disabled, 'low is higher than high').to.equal(true);
    setInput($('.rf-value2', dlg), '$200.00');
    byText('button', /and another condition/, dlg).click();
    await waitFor(() => $$('.rb-clause', dlg).length === 3, 'clause 3');
    const sel3 = $$('.rf-field', dlg)[2]; sel3.value = 'direction'; sel3.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $('.rf-dir', dlg), 'direction picker');
    expect($('button.rf-save', dlg).disabled, 'direction not chosen').to.equal(true);
    const dir = $('.rf-dir', dlg); dir.value = 'out'; dir.dispatchEvent(new Event('change', { bubbles: true }));
    await pickCat($('hk-category-select', dlg), 'Travel').catch(() => pickCat($('hk-category-select', dlg), 'Groceries'));
    await waitFor(() => /would have matched \d+/i.test(text($('.rf-bt', dlg))), 'backtest');
    await waitFor(() => !$('button.rf-save', dlg).disabled, 'save enabled');
    $('button.rf-save', dlg).click();
    await waitFor(async () => (await api('/api/rules')).length === before + 1, 'saved');
    const r = (await api('/api/rules')).find((x) => /qantas/i.test(x.match_json));
    expect(JSON.parse(r.match_json).all_of).to.deep.equal([{ field: 'descriptor', op: 'contains', value: 'qantas' }, { field: 'amount_abs', op: 'between', value: [5000, 20000] }, { field: 'direction', op: 'eq', value: 'out' }]);
    expect(r.origin).to.equal('user');
    await waitFor(() => $$('tbody tr').some((row) => /amount between \$50\.00 and \$200\.00/.test(text(row)) && /qantas/.test(text(row))), 'readable on the Rules page');
  });
});

describe('Flagging for review', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });
  const chaseId = async () => (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;

  it('Transactions: flag from a row (with a reason), it jumps to the top and stays there; unflag puts it back', async () => {
    await mount('/transactions');
    await waitFor(() => $$('tbody tr[data-id]').length > 5, 'rows');
    const rows = () => $$('tbody tr[data-id]');
    const target = rows()[4]; const id = target.dataset.id;
    expect(rows()[0].classList.contains('flagged')).to.equal(false);
    $('button.flag-btn', target).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Flag for review/.test(text(d))), 'reason prompt');
    setInput($('input', dlg), 'ask about this');
    byText('button', /^Flag it$/, dlg).click();
    await waitFor(() => rows()[0].dataset.id === id, 'flagged row first');
    expect(rows()[0].classList.contains('flagged')).to.equal(true);
    expect(text($('[data-flag]', rows()[0]))).to.match(/ask about this/);
    expect($('button.flag-btn', rows()[0]).getAttribute('aria-pressed')).to.equal('true');
    // still first after reload; pager keeps it on page one
    await mount('/transactions');
    await waitFor(() => $$('tbody tr[data-id]')[0]?.dataset.id === id, 'still first after reload');
    $('button.flag-btn', rows()[0]).click();
    await waitFor(() => !rows().some((r) => r.classList.contains('flagged')), 'unflagged');
    expect((await api(`/api/transactions?limit=1&q=`))[0].id).to.not.equal(Number(id));
  });

  it('the categorize dialog can flag at the same time (Backlog and Home), with a reason', async () => {
    const chase = await chaseId();
    await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'HMM STORE', amountCents: -4200 } });
    await mount('/backlog');
    const row = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((r) => /HMM STORE/.test(text(r))), 'row');
    const id = Number(row.dataset.id);
    await pickCat($('.tcat hk-category-select', row), 'Groceries');
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'confirm dialog');
    expect($('.flag-reason', dlg), 'reason box only when flagging').to.not.exist;
    $('#flag-it', dlg).click();
    setInput(await waitFor(() => $('.flag-reason', dlg), 'reason box'), 'too high?');
    $('button.primary.confirm', dlg).click();
    await waitFor(async () => (await api('/api/transactions?q=HMM%20STORE'))[0]?.flagged === 1, 'flagged on save');
    const t = (await api('/api/transactions?q=HMM%20STORE'))[0];
    expect(t.flag_reason).to.equal('too high?'); expect(t.splits[0].category).to.equal('Groceries'); expect(t.id).to.equal(id);
    // flagged transactions are shown first on Transactions
    await mount('/transactions');
    await waitFor(() => $$('tbody tr[data-id]')[0]?.dataset.id === String(id), 'first on Transactions');
  });
});

describe('Split dialog shows the note', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('the note is in the dialog (editable) so you can split by what was bought; a changed note is saved with the split, an unchanged one is left alone', async () => {
    const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
    const made = await api('/api/transactions', { method: 'POST', body: { accountId: chase, descriptor: 'AMZN Mktp US*SPLITME', amountCents: -3000, note: 'cat food,dress shirt' } });
    await mount('/backlog');
    const row = await waitFor(() => $$('.trow.txn').find((r) => r.dataset.id === String(made.id)), 'the row');
    $('.texpand', row).click(); byText('button', /^Split…$/, row).click();
    const dlg = await waitFor(() => $$('dialog').find((d) => d.open && $('.splitsave', d)), 'split dialog');
    expect($('input.splitnote', dlg).value, 'the note is present').to.equal('cat food,dress shirt');
    const [c1, c2] = $$('hk-category-select', dlg); const [a1, a2] = $$('input.splitamt', dlg);
    await pickCat(c1, 'Groceries'); await pickCat(c2, 'Eating Out');
    setInput(a1, '12.00'); setInput(a2, '18.00');
    await waitFor(() => !$('.splitsave', dlg).disabled, 'adds up');
    setInput($('input.splitnote', dlg), 'cat food ($12), dress shirt ($18)');
    $('.splitsave', dlg).click();
    await waitFor(async () => (await api('/api/transactions?q=SPLITME'))[0]?.splits.length === 2, 'split saved');
    const t = (await api('/api/transactions?q=SPLITME'))[0];
    expect(t.note).to.equal('cat food ($12), dress shirt ($18)');
  });
});
