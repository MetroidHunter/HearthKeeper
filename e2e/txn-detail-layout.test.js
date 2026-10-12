import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, trapErrors, sleep } from './helpers.js';

const rect = (el) => el.getBoundingClientRect();
const overlap = (a, b) => { const x = rect(a), y = rect(b); return x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom; };

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Transaction detail dialog layout (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('every split row keeps its category box and amount box apart and inside the dialog', async () => {
      await mount('/transactions');
      const row = await waitFor(() => $$('tbody tr.clickable').find((r) => r.checkVisibility()), 'a transaction row');
      row.click();
      const dlg = await waitFor(() => $('dialog.txn-detail[open]'), 'the detail dialog');
      await waitFor(() => $$('hk-category-select', dlg).length > 0, 'a split row');
      // add a second part so there are two rows, and the remove button is in play
      $$('button', dlg).find((b) => /＋ split/.test(b.textContent)).click();
      await waitFor(() => $$('hk-category-select', dlg).length > 1, 'two split rows');
      const box = rect(dlg);
      for (const picker of $$('hk-category-select', dlg)) {
        const sr = picker.closest('.splitrow, .row'); // the row holding this part's category and amount
        const cat = $('input', picker), amt = $$('input', sr).find((i) => !picker.contains(i));
        expect(cat, 'category input').to.exist; expect(amt, 'amount input').to.exist;
        expect(overlap(cat, amt), 'category box runs into the amount box').to.equal(false);
        for (const el of [cat, amt]) { expect(rect(el).left).to.be.at.least(box.left); expect(rect(el).right).to.be.at.most(box.right + 0.5); }
        for (const b of $$('button', sr)) expect(overlap(cat, b), 'category box under a button').to.equal(false);
      }
    });
  });
}
