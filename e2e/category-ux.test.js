import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep, api, setInput, pickCat, confirmDialog } from './helpers.js';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const dlg = () => $$('dialog').find((d) => d.open && !d.classList.contains('busy'));
const inView = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth; };
const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
const cat = async (n) => (await api('/api/categories')).find((c) => c.name === n);
const dollars = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const closeDialogs = () => $$('dialog').forEach((d) => d.open && d.close());
const toastText = () => $$('.toast').map(text).join(' | ');

for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
  describe(`Categories page (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); try { localStorage.removeItem('hk-intro-open'); } catch { /* none */ } await setViewport({ width, height }); await sleep(100); });
    afterEach(async () => { closeDialogs(); $$('.toast').forEach((t) => t.remove()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });
    const openAdd = async () => { const b = await waitFor(() => $('button.add-category'), 'the Add category button'); b.click(); return waitFor(dlg, 'the add dialog'); };

    it('adding a category is a dialog that asks for no money, and finishes with an obvious toast', async () => {
      await mount('/categories');
      expect($('.yearly-add'), 'no yearly hint on the page').to.equal(null);
      expect($$('input').filter((i) => /monthly/i.test(i.getAttribute('aria-label') ?? i.placeholder ?? '')), 'no monthly amount field on the page').to.have.length(0);
      const d = await openAdd();
      expect(text($('h3', d))).to.match(/add a category/i);
      expect($$('input', d).filter((i) => /\$|monthly|amount/i.test(`${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`)), 'the dialog has no money field').to.have.length(0);
      expect(byText('button', /^Add category$/, d).disabled, 'cannot add without a name').to.equal(true);
      setInput($('input[aria-label="Name"]', d), 'E2E Hobby'); setInput($('input[aria-label="Group"]', d), 'Fun');
      await waitFor(() => !byText('button', /^Add category$/, d).disabled, 'Add to enable');
      byText('button', /^Add category$/, d).click();
      const toast = await waitFor(() => $$('.toast').find((t) => /E2E Hobby/.test(text(t))), 'a toast naming the new category');
      expect(toast.getAttribute('role')).to.equal('status');
      expect(text(toast)).to.match(/added/i);
      expect(inView(toast), 'the toast is on screen').to.equal(true);
      await waitFor(() => !dlg(), 'the dialog to close');
      const row = await waitFor(() => $$('tbody tr').find((r) => /E2E Hobby/.test(text(r))), 'the new row');
      expect(text(row)).to.contain('$0.00'); // nothing in it yet
      const c = await cat('E2E Hobby');
      expect((await api(`/api/categories/${c.id}`)).history, 'no budget history: money belongs to a plan').to.deep.equal([]);
    });

    it('adding a name that exists keeps the dialog open with a clear, visible message', async () => {
      await mount('/categories');
      const d = await openAdd();
      setInput($('input[aria-label="Name"]', d), 'groceries');
      byText('button', /^Add category$/, d).click();
      const err = await waitFor(() => $('[role="alert"]', d), 'an error inside the dialog');
      expect(text(err)).to.match(/"Groceries" already exists/);
      expect(text(err)).to.not.match(/internal error/i);
      expect(dlg(), 'the dialog stays so the name can be fixed').to.equal(d);
      expect(inView(err), 'the message is on screen').to.equal(true);
      await sleep(1500); // unlike a toast it does not fade
      expect($('[role="alert"]', d), 'still there').to.not.equal(null);
      expect(getComputedStyle(err).color, 'in the error colour').to.not.equal(getComputedStyle(d).color);
      setInput($('input[aria-label="Name"]', d), 'Groceries 2');
      byText('button', /^Add category$/, d).click();
      await waitFor(() => !dlg(), 'the dialog to close once the name is new');
      await waitFor(() => $$('.toast').some((t) => /Groceries 2/.test(text(t))), 'the toast');
    });

    it('the table has a Balance column with each envelope\'s amount and no Kind column', async () => {
      await mount('/categories');
      await waitFor(() => $$('tbody tr').length > 5, 'rows');
      const heads = $$('thead th').map((h) => text(h));
      expect(heads).to.include('Balance'); expect(heads).to.not.include('Kind');
      const idx = heads.indexOf('Balance');
      const g = await cat('Groceries');
      const row = $$('tbody tr').find((r) => /Groceries/.test(text(r)));
      expect(text($$('td', row)[idx])).to.equal(dollars(g.balance_cents));
      expect(g.balance_cents).to.not.equal(0);
      for (const r of $$('tbody tr')) expect(text($$('td', r)[idx]), text(r)).to.match(/^(-?\$[\d,]+\.\d\d|N\/A)$/);
    });

    it('Retire shows what is in the envelope and where it can go, with the rules and an option to switch them off', async () => {
      const g = await cat('Groceries'), eat = await cat('Eating Out');
      await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'TRADER JOE' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' } });
      const rulesBefore = (await api(`/api/categories/${g.id}`)).rules;
      expect(rulesBefore.length).to.be.greaterThan(0);
      await mount('/categories');
      const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r)) && $('button.retire', r)), 'groceries row');
      $('button.retire', row).click();
      const d = await waitFor(dlg, 'retire dialog');
      const preview = (await api(`/api/categories/${g.id}`)).retire;
      expect(text($('.retire-balance', d))).to.contain(dollars(preview.afterCents));
      expect(text($('.retire-balance', d))).to.match(/Groceries/);
      expect($$('.cat-rule', d).length, 'every rule is listed').to.equal(rulesBefore.length);
      expect(text($('.cat-rule', d))).to.not.equal('');
      const off = $('input.disable-rules', d);
      expect(off, 'a switch for the rules').to.not.equal(null);
      expect(off.checked, 'on by default: a retired category should stop catching transactions').to.equal(true);
      expect(text(off.closest('label'))).to.match(/turn off/i);
      expect($$('hk-category-select', d)).to.have.length(1);
      await pickCat($('hk-category-select', d), 'Eating Out');
      const dest = await waitFor(() => $('.dest-balance', d), 'the destination balance');
      expect(text(dest)).to.contain('Eating Out').and.to.contain(dollars(eat.balance_cents)).and.to.contain(dollars(eat.balance_cents + preview.afterCents));
      await confirmDialog(/Retire/);
      await waitFor(async () => (await cat('Groceries')).status === 'retired', 'retired');
      expect((await api(`/api/categories/${g.id}`)).rules.every((r) => r.enabled === 0), 'its rules are off').to.equal(true);
      expect((await cat('Eating Out')).balance_cents).to.equal(eat.balance_cents + preview.afterCents);
      expect(toastText()).to.match(/retired/i);
    });

    it('Retire can leave the rules on', async () => {
      const g = await cat('Groceries');
      await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'TRADER JOE' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' } });
      await mount('/categories');
      const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r)) && $('button.retire', r)), 'groceries row');
      $('button.retire', row).click();
      const d = await waitFor(dlg, 'retire dialog');
      $('input.disable-rules', d).click();
      await confirmDialog(/Retire/);
      await waitFor(async () => (await cat('Groceries')).status === 'retired', 'retired');
      expect((await api(`/api/categories/${g.id}`)).rules.every((r) => r.enabled === 1)).to.equal(true);
    });

    it('an overspent envelope cannot be retired: the button is off and says why, and the server agrees', async () => {
      const m = await cat('Eating Out'); const acct = (await api('/api/accounts'))[0].id;
      const t = await api('/api/transactions', { method: 'POST', body: { accountId: acct, descriptor: 'BIG DINNER', amountCents: -(m.balance_cents + 5000), categoryId: m.id } });
      expect(t.error).to.equal(undefined);
      expect((await cat('Eating Out')).balance_cents).to.equal(-5000);
      await mount('/categories');
      const row = await waitFor(() => $$('tbody tr').find((r) => /Eating Out/.test(text(r))), 'the row');
      expect(text($$('td', row)[$$('thead th').map(text).indexOf('Balance')])).to.equal('-$50.00');
      const b = $('button.retire', row);
      expect(b.disabled).to.equal(true);
      expect(b.title).to.match(/overspent/i);
      const res = await fetch(`/api/categories/${m.id}/retire`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: '{}' });
      expect(res.status).to.equal(400);
      expect((await cat('Eating Out')).status).to.equal('active');
    });

    it('Unretire lists the rules and can turn them back on', async () => {
      const g = await cat('Groceries');
      await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'TRADER JOE' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' } });
      await api(`/api/categories/${g.id}/retire`, { method: 'POST', body: { disableRules: true } });
      const n = (await api(`/api/categories/${g.id}`)).rules.length;
      expect((await api(`/api/categories/${g.id}`)).rules.every((r) => r.enabled === 0)).to.equal(true);
      await mount('/categories');
      const row = await waitFor(() => $$('tbody tr').find((r) => /Groceries/.test(text(r)) && $('button.unretire', r)), 'unretire button');
      $('button.unretire', row).click();
      const d = await waitFor(dlg, 'unretire dialog');
      expect($$('.cat-rule', d)).to.have.length(n);
      const on = $('input.enable-rules', d);
      expect(on, 'a switch to turn the rules back on').to.not.equal(null);
      expect(text(on.closest('label'))).to.match(/turn .*back on/i);
      await confirmDialog(/Unretire/);
      await waitFor(async () => (await cat('Groceries')).status === 'active', 'unretired');
      expect((await api(`/api/categories/${g.id}`)).rules.every((r) => r.enabled === 1), 'rules are back on').to.equal(true);
      expect(toastText()).to.match(/unretired/i);
    });

    it('the category page shows which of its rules are off', async () => {
      const g = await cat('Groceries');
      await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'TRADER JOE' }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto' } });
      const id = (await api(`/api/categories/${g.id}`)).rules.find((r) => r.match_json.includes('TRADER JOE')).id;
      await api(`/api/rules/${id}`, { method: 'PATCH', body: { enabled: 0 } });
      await mount(`/categories/${g.id}`);
      const r = await waitFor(() => $$('.cat-rule').find((x) => /TRADER JOE/.test(text(x))), 'the rule');
      expect(text(r)).to.match(/\boff\b/i);
    });
  });

  describe(`Budget only lists envelopes that are in the plan (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport({ width, height }); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });
    const listed = () => (shown($('.btable')) ? $$('.btable tbody tr b') : $$('.brow-name')).map(text);

    it('a new category is not on Budget until a budget is set for it', async () => {
      await api('/api/categories', { method: 'POST', body: { name: 'Brand New', startMonth: thisMonth() } });
      await mount('/budget');
      await waitFor(() => listed().length > 5, 'rows');
      expect(listed()).to.include('Groceries').and.to.not.include('Brand New');
      const c = await cat('Brand New');
      await api(`/api/categories/${c.id}/budget`, { method: 'POST', body: { monthlyCents: 4200, effectiveMonth: thisMonth() } });
      await mount('/budget');
      await waitFor(() => listed().includes('Brand New'), 'Brand New once it has a budget');
    });
  });

  describe(`Earnings fit their cards (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport({ width, height }); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });
    const escapes = (card) => {
      const c = card.getBoundingClientRect(); const out = [];
      for (const el of card.querySelectorAll('*')) {
        if (!shown(el) || el.closest('[hidden]')) continue;
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        if (r.right > c.right + 1 || r.left < c.left - 1) out.push(`${el.tagName.toLowerCase()}${el.className ? '.' + el.className : ''} "${text(el).slice(0, 20)}" ${Math.round(r.left)}-${Math.round(r.right)} vs card ${Math.round(c.left)}-${Math.round(c.right)}`);
      }
      return out;
    };

    it('a scenario card and its rows are inside the card backing', async () => {
      await mount('/earnings');
      const cards = await waitFor(() => { const c = $$('main .card').filter((x) => /\/mo net/.test(text(x))); return c.length && c; }, 'a scenario card');
      for (const card of cards) {
        expect(escapes(card), 'elements poking out of the card').to.deep.equal([]);
        expect(card.scrollWidth, 'the card does not scroll sideways').to.be.at.most(card.clientWidth + 1);
      }
      expect(document.documentElement.scrollWidth, 'no horizontal page scroll').to.be.at.most(window.innerWidth);
    });

    it('the scenario editor and every line in it stay inside the card', async () => {
      await mount('/earnings');
      byText('button', /New scenario/).click();
      const card = await waitFor(() => $$('main .card').find((x) => $('input.gross', x)), 'the editor');
      byText('button', /＋ line/, card).click();
      await waitFor(() => $$('input.gross', card).length === 2, 'two lines');
      setInput($$('input.gross', card)[0], '1234567.89'); setInput($$('input.work', card)[0], '100'); setInput($$('input.tax', card)[0], '32');
      await sleep(50);
      expect(escapes(card), 'elements poking out of the card').to.deep.equal([]);
      expect(card.scrollWidth).to.be.at.most(card.clientWidth + 1);
      for (const i of $$('input', card)) if (shown(i) && i.type !== 'checkbox') expect(i.getBoundingClientRect().width, 'inputs are usable, not squeezed').to.be.at.least(48);
      expect(document.documentElement.scrollWidth).to.be.at.most(window.innerWidth);
    });
  });

  describe(`Transfers never move $0 (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport({ width, height }); await sleep(100); });
    afterEach(async () => { closeDialogs(); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('Move stays off until there are two different envelopes and an amount above zero', async () => {
      await mount('/transfers');
      const card = await waitFor(() => $$('.card').find((c) => byText('button', /^Move$/, c)), 'manual card');
      const move = byText('button', /^Move$/, card);
      expect(move.disabled, 'empty').to.equal(true);
      const [from, to] = $$('hk-category-select', card);
      await pickCat(from, 'Groceries'); await pickCat(to, 'Eating Out');
      const amt = $('input[aria-label="Amount"]', card);
      expect(move.disabled, 'no amount').to.equal(true);
      for (const v of ['0', '0.00', '-5', 'abc', '0.004']) { setInput(amt, v); await sleep(20); expect(move.disabled, `"${v}"`).to.equal(true); }
      setInput(amt, '5'); await waitFor(() => !move.disabled, 'enabled for $5');
      await pickCat(to, 'Groceries'); await sleep(20);
      expect(move.disabled, 'the same envelope on both sides').to.equal(true);
      await pickCat(to, 'Eating Out'); await waitFor(() => !move.disabled, 'enabled again');
      const n = (await api('/api/transfers')).length;
      move.click();
      await waitFor(async () => (await api('/api/transfers')).length === n + 1, 'the transfer');
      expect((await api('/api/transfers'))[0].legs).to.contain('500');
      expect(toastText()).to.match(/moved \$5\.00/i);
    });

    it('Zero out needs an amount above zero too', async () => {
      await mount('/transfers');
      const card = await waitFor(() => $$('.card').find((c) => byText('button', /^Move$/, c)), 'manual card');
      await pickCat($$('hk-category-select', card)[0], 'Groceries');
      const z = byText('button', /^Zero out$/, card);
      expect(z.disabled).to.equal(true);
      setInput($('input[aria-label="Amount"]', card), '0'); await sleep(20);
      expect(z.disabled).to.equal(true);
      setInput($('input[aria-label="Amount"]', card), '3'); await waitFor(() => !z.disabled, 'enabled for $3');
    });

    it('Place the pool will not commit an empty or $0 row', async () => {
      await mount('/transfers');
      const pool = await waitFor(() => byText('button', /^Place…$/), 'place button');
      pool.click();
      const commit = await waitFor(() => $$('button.primary').find((b) => /^Commit$/.test(text(b)) && b.closest('.card') && /remaining/.test(text(b.closest('.card')))), 'place commit');
      expect(commit.disabled, 'nothing chosen').to.equal(true);
      const card = commit.closest('.card');
      await pickCat($('hk-category-select', card), 'Groceries');
      expect(commit.disabled, 'chosen but $0').to.equal(true);
      setInput($('input[aria-label="Amount"]', card), '0'); await sleep(20);
      expect(commit.disabled).to.equal(true);
    });
  });
}
