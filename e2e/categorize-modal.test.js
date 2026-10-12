import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, trapErrors, sleep, pickCat, api } from './helpers.js';

const rect = (el) => el.getBoundingClientRect();
const cy = (el) => { const r = rect(el); return r.top + r.height / 2; };

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Categorize dialog (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '1'); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    const open = async (catName = 'Groceries') => {
      await mount('/');
      const card = await waitFor(() => $('.trow.txn[data-cat=missing]'), 'a row with a category dropdown');
      await pickCat($('.tcat hk-category-select', card), catName);
      return waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'the dialog');
    };

    it('only the one-line change is shown: no extra detail text, no long labels', async () => {
      const dlg = await open();
      expect(text(dlg)).to.not.match(/Balance left in the envelope|spent this month|target \$/i);
      expect($('.impact-line', dlg)).to.exist;
      const rule = $('label.makerule', dlg);
      expect(text(rule)).to.equal('Make this a rule');
      expect(rect(rule).height, 'the rule label stays on one line').to.be.lessThan(34);
      const flag = $('label.flagrow', dlg);
      expect(text(flag)).to.equal('Flag for review');
      expect(text(dlg)).to.not.match(/stays flagged/);
    });

    it('the arrow is vertically centered with the figures it joins', async () => {
      const dlg = await open();
      const arrow = $('.impact-arrow', dlg), newTotal = $('.impact-new', dlg), delta = $('.impact-delta', dlg);
      expect(arrow, 'an arrow element').to.exist;
      expect(Math.abs(cy(arrow) - cy(newTotal)), 'arrow vs new total').to.be.at.most(1.5);
      expect(Math.abs(cy(arrow) - cy(delta)), 'arrow vs change').to.be.at.most(1.5);
    });

    it('the bar shows spent, what is left, and the growth this adds, and the growth animates in from the current level', async () => {
      const dlg = await open();
      const bar = await waitFor(() => $('.impact-bar', dlg), 'the bar');
      const spent = Number(bar.dataset.spent), added = Number(bar.dataset.delta), scale = Number(bar.dataset.scale);
      expect(added, 'this transaction adds spending').to.not.equal(0);
      const seg = (k) => $(`.seg-${k}`, bar), w = (k) => rect(seg(k)).width;
      expect(seg('spent') && seg('new') && seg('left'), 'three segments').to.exist;
      const total = rect(bar).width;
      const head = $('.impact-bar-head', dlg);
      const fmt = (c) => '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
      expect(text(seg('spent')) + text(head), 'the spent amount is written on the green part, or above the bar when it is too narrow').to.include(fmt(spent));
      // starts at the current level, then grows
      expect(w('new'), 'growth starts empty').to.be.lessThan(total * 0.01 + 1);
      await sleep(1100);
      expect(w('new') / total, 'growth ends at its share of the bar').to.be.closeTo(Math.abs(added) / scale, 0.02);
      expect(w('spent') / total).to.be.closeTo(spent / scale, 0.02);
      expect(rect(bar).right).to.be.at.most(window.innerWidth);
      expect(text(seg('new')) + text(head), 'the growth is labelled').to.include(fmt(added));
      expect(text(head)).to.match(/Budget \$[\d,]+\.\d\d\/mo/);
    });

    // a transaction with a unique description, so its row can be found among the others
    const seed = async (spendCents, desc, cents) => {
      const cats = await api('/api/categories'); const groc = cats.find((c) => c.name === 'Groceries'); const acct = (await api('/api/accounts'))[0].id;
      if (spendCents) await api('/api/transactions', { method: 'POST', body: { accountId: acct, descriptor: 'EARLIER GROCERIES', amountCents: -spendCents, categoryId: groc.id } });
      await api('/api/transactions', { method: 'POST', body: { accountId: acct, descriptor: desc, amountCents: cents } });
      await mount('/');
      const card = await waitFor(() => $$('.trow.txn[data-cat=missing]').find((c) => text(c).includes(desc)), `the ${desc} row`);
      await pickCat($('.tcat hk-category-select', card), 'Groceries');
      return waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'the dialog');
    };

    it('with room to spare, spent / added / left all carry their figures inside the bar, and the parts add up to the whole', async () => {
      const dlg = await seed(30_000, 'ZZ MIDSIZE', -20_000); // $300 spent + $200 more, of an $800 budget
      const bar = await waitFor(() => $('.impact-bar', dlg), 'the bar'); await sleep(1100);
      for (const k of ['spent', 'new', 'left']) expect(text($(`.seg-${k}`, bar)), `${k} labelled on the bar`).to.match(/\$\d/);
      const sum = ['spent', 'new', 'left'].reduce((a, k) => a + rect($(`.seg-${k}`, bar)).width, 0);
      expect(sum, 'the three parts fill the bar exactly').to.be.closeTo(rect(bar).width, 1.5);
      expect($('.impact-tick', bar)).to.not.exist;
    });

    it('past the budget, the new part turns red, the bar stretches to fit, and a tick marks the budget', async () => {
      const dlg = await seed(79_000, 'ZZ OVER IT', -5_000); // $790 + $50 against $800
      const bar = await waitFor(() => $('.impact-bar', dlg), 'the bar'); await sleep(1100);
      expect($('.seg-new', bar).classList.contains('over')).to.equal(true);
      expect($('.impact-tick', bar), 'a tick at the budget').to.exist;
      expect(rect($('.seg-left', bar)).width, 'nothing left').to.be.lessThan(1);
      const tick = rect($('.impact-tick', bar)).left - rect(bar).left;
      expect(tick / rect(bar).width, 'the tick sits at budget / the stretched scale').to.be.closeTo(80_000 / Number(bar.dataset.scale), 0.02);
      expect(Number(bar.dataset.scale), 'the bar stretches to the new spent total').to.be.greaterThan(80_000);
    });

    it('a credit takes spending back: the freed part is shown, and it does not exceed what was spent', async () => {
      const dlg = await seed(30_000, 'ZZ REFUND', 5_000);
      const bar = await waitFor(() => $('.impact-bar', dlg), 'the bar'); await sleep(1100);
      const freed = $('.seg-new', bar); expect(freed.classList.contains('freed')).to.equal(true);
      expect(text(freed) + text($('.impact-bar-head', dlg)), 'the freed amount is labelled').to.include('−$50.00');
      expect(Number(bar.dataset.delta)).to.equal(5_000);
      expect(Number(bar.dataset.spent) + Number(bar.dataset.delta), 'the green part plus the freed part is what was spent before').to.equal(30_000 + 8_412);
    });

    it('no bar for an envelope without a monthly budget', async () => {
      const cats = await api('/api/categories'); const none = cats.find((c) => c.kind === 'expense' && !c.system && /Gig|Salary|Needs/.test(c.name)) ?? null;
      if (!none) return;
      const dlg = await open(none.name);
      expect($('.impact-bar', dlg)).to.not.exist;
    });
  });
}
