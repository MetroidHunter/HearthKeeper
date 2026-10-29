import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, sleep, $, $$, text, byText, trapErrors, api, setInput, pickCat } from './helpers.js';

const money = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shown = (el) => !!el && el.checkVisibility();

for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
  describe(`Envelope quick view and Back (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); await setViewport({ width, height }); trap = trapErrors(); });
    afterEach(async () => { trap.stop(); $$('dialog').forEach((d) => d.close()); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });
    const row = async (n) => (await api('/api/budget')).rows.find((r) => r.name === n);
    /** Click the visible row for an envelope on the Budget page (the table on a desktop, the list on a phone). */
    const clickRow = async (n) => {
      const el = await waitFor(() => [...$$('.btable tbody tr'), ...$$('.brow')].find((r) => shown(r) && text($('b', r)) === n), `the ${n} row`);
      el.click();
    };
    const quick = () => waitFor(() => $$('dialog.quickview').find((d) => d.open), 'the quick view');

    it('clicking an envelope opens a quick view with spent / target, the yearly amount, a pace bar and a link to the category page', async () => {
      const g = await row('Groceries');
      await mount('/budget');
      await clickRow('Groceries');
      const q = await quick();
      expect(location.hash, 'stays on the Budget page').to.equal('#/budget');
      expect(text($('h2, h3', q))).to.contain('Groceries');
      expect(text($('.qv-spent', q))).to.equal(`${money(g.spent[0])} / ${money(g.targetCents)}`);
      expect(text($('.qv-yearly', q))).to.contain(money(g.targetCents * 12)).and.to.match(/a year/);
      const pace = $('.qv-pace', q);
      expect(pace, 'the pace bar').to.exist;
      expect($('.qv-spentbar', pace), 'how much is spent').to.exist;
      expect($('.qv-marker', pace), 'where an even pace would be by today').to.exist;
      expect(text($('.qv-pace-note', q)), 'says whether spending is ahead of or behind pace').to.match(/day \d+ of \d+/i).and.to.match(/pace|on track/i);
      expect(text($('.qv-balance', q))).to.contain(money(g.currentCents));
      const link = $('a.qv-open', q);
      expect(link.getAttribute('href')).to.equal(`#/categories/${g.id}`);
      expect(shown(link)).to.equal(true);
    });

    it('the pencil and the star on a row do not open the quick view', async () => {
      await mount('/budget');
      const fav = await waitFor(() => $$('button.fav, button.bfav').find(shown), 'a star');
      fav.click();
      await sleep(150);
      expect($$('dialog.quickview')).to.have.length(0);
    });

    it('moves money from this envelope to another and shows the new balance', async () => {
      const g = await row('Groceries'), gas = await row('Gas');
      await mount('/budget');
      await clickRow('Groceries');
      const q = await quick();
      const move = $('button.qv-move', q);
      expect(move.disabled, 'needs a destination and an amount').to.equal(true);
      await pickCat($('hk-category-select', q), 'Gas');
      expect(move.disabled, 'still needs an amount').to.equal(true);
      setInput($('input[aria-label="Amount"]', q), '5.00');
      await waitFor(() => !move.disabled, 'Move to enable');
      move.click();
      await waitFor(async () => (await row('Gas')).currentCents === gas.currentCents + 500, 'Gas to receive $5');
      expect((await row('Groceries')).currentCents).to.equal(g.currentCents - 500);
      await waitFor(() => text($('.qv-balance', q)).includes(money(g.currentCents - 500)), 'the quick view balance to update');
      expect(q.open, 'the quick view stays open so you can keep going').to.equal(true);
    });

    it('does not offer the envelope itself as a destination', async () => {
      await mount('/budget');
      await clickRow('Groceries');
      const q = await quick();
      const input = $('hk-category-select input', q);
      input.focus();
      setInput(input, 'Groc');
      await sleep(150);
      expect($$('.cs-pop .opt').map(text), 'no Groceries to move to').to.not.include('Groceries');
      setInput(input, 'Gas');
      await waitFor(() => $$('.cs-pop .opt').some((o) => text(o) === 'Gas'), 'Gas offered');
    });

    it('the link opens the category page, and Back returns to the Budget page at the same scroll position', async () => {
      const g = await row('Groceries');
      await mount('/budget');
      await waitFor(() => $$('.btable tbody tr, .brow').filter(shown).length > 10, 'rows');
      window.scrollTo(0, 450);
      await waitFor(() => window.scrollY > 300, 'the page to scroll');
      const was = window.scrollY;
      await sleep(100);
      const el = [...$$('.btable tbody tr'), ...$$('.brow')].find((r) => shown(r) && text($('b', r)) === 'Groceries');
      el.click();
      const q = await quick();
      $('a.qv-open', q).click();
      await waitFor(() => location.hash === `#/categories/${g.id}` && $('.back'), 'the category page');
      expect(q.isConnected && q.open, 'the quick view is closed').to.not.equal(true);
      expect(window.scrollY, 'a new page starts at the top').to.be.below(50);
      expect(text($('.back'))).to.match(/Back/);
      $('.back').click();
      await waitFor(() => location.hash === '#/budget' && $$('.btable tbody tr, .brow').filter(shown).length > 10, 'back on Budget (not the category list)');
      await waitFor(() => Math.abs(window.scrollY - was) < 40, `scroll to return to about ${was} (at ${window.scrollY})`);
    });

    it('Back goes to wherever you came from, not to the category list', async () => {
      const g = await row('Groceries');
      await mount('/transactions');
      await sleep(50);
      location.hash = `#/categories/${g.id}`;
      await waitFor(() => $('.back'), 'the category page');
      $('.back').click();
      await waitFor(() => location.hash === '#/transactions', 'back on Transactions');
    });

    it('Back falls back to the list when the page was opened directly', async () => {
      const g = await row('Groceries');
      history.replaceState(null, '', `#/categories/${g.id}`);
      await mount(`/categories/${g.id}`);
      await waitFor(() => $('.back'), 'the category page');
      $('.back').click();
      await waitFor(() => location.hash === '#/categories', 'the category list');
    });

    it('Back on a plan goes to where you came from', async () => {
      await mount('/transactions');
      await sleep(50);
      const plans = await api('/api/plans');
      location.hash = `#/plans/${plans[0].id}`;
      await waitFor(() => $('.plan-back .back'), 'the plan page');
      $('.plan-back .back').click();
      await waitFor(() => location.hash === '#/transactions', 'back on Transactions');
    });

    it('the Transactions "need fixing" chip has a Back that returns to Months', async () => {
      const months = await api('/api/months');
      const m = months.find((x) => x.items.find((i) => i.key === 'category' && i.count > 0));
      await mount('/months');
      const card = await waitFor(() => $$('details.month').find((c) => c.dataset.month === m.month), 'month card');
      $('.mcheck[data-key=category] a.mfix', card).click();
      await waitFor(() => $('.needs-chip'), 'filter chip');
      byText('.needs-chip .back, .needs-chip button', /Back$/).click();
      await waitFor(() => location.hash === '#/months' && $('details.month'), 'back on Months');
    });
  });
}
