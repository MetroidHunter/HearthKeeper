import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep, pickCat, api, setInput } from './helpers.js';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Split transactions lower every envelope they touch (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '1'); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    const bal = async (name) => (await api('/api/budget')).rows.find((r) => r.name === name).currentCents;

    it('splitting a $30 charge across two envelopes takes $10 and $20 out of them, on Home and the Budget page', async () => {
      const [a, b] = ['Groceries', 'Eating Out'];
      const acct = (await api('/api/accounts'))[0].id;
      const { id } = await api('/api/transactions', { method: 'POST', body: { accountId: acct, amountCents: -3000, descriptor: 'E2E SPLIT STORE' } });
      const [a0, b0] = [await bal(a), await bal(b)];

      await mount('/');
      const card = await waitFor(() => $$('.trow.txn').find((c) => Number(c.dataset.id) === id), 'the new charge');
      $('.texpand', card).click();
      await waitFor(() => byText('button', /^Split…/, card)?.checkVisibility(), 'the Split button');
      byText('button', /^Split…/, card).click();
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Split E2E SPLIT STORE/.test(text(d))), 'the split dialog');
      const pickers = () => $$('hk-category-select', dlg);
      await pickCat(pickers()[0], a); await pickCat(pickers()[1], b);
      const [x, y] = $$('.splitamt', dlg);
      setInput(x, '10.00'); await sleep(30); setInput($$('.splitamt', dlg)[1], '20.00'); await sleep(30);
      await waitFor(() => !$('.splitsave', dlg).disabled, 'Save split to enable');
      $('.splitsave', dlg).click();

      await waitFor(async () => (await bal(a)) === a0 - 1000 && (await bal(b)) === b0 - 2000, 'both envelopes to go down');
      // the page itself shows the new numbers, not just the API
      const fmt = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await waitFor(() => {
        const favs = $$('.fav').map((f) => text(f));
        return [[a, a0 - 1000], [b, b0 - 2000]].every(([n, c]) => { const f = favs.find((t) => t.startsWith(n)); return !f || f.includes(fmt(c)); }) && favs.some((t) => /^(Groceries|Eating Out)/.test(t));
      }, 'Home favorites to show the lowered balances');
      await mount('/budget');
      await waitFor(() => $$('tr, .brow, .trow').some((r) => text(r).includes(a) && text(r).includes(fmt(a0 - 1000))), `Budget page to show ${a} at ${fmt(a0 - 1000)}`);
    });
  });
}
