import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, sleep, api } from './helpers.js';

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify(body) }).then((r) => r.json());
const HDR = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Adding a tip to a pending transaction (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    const openRow = async (name) => {
      await mount('/transactions');
      await waitFor(() => $$('tbody tr').length > 3, 'rows');
      setInput($('input[type=search]'), name, 'change');
      const row = await waitFor(() => $$('tbody tr.clickable').find((r) => r.checkVisibility() && text(r).includes(name)), `the ${name} row`);
      row.click();
      return waitFor(() => $('dialog.txn-detail[open]'), 'the detail dialog');
    };

    it('a pending charge takes a tip: the amount goes up, the dialog says so, and the list shows the new total', async () => {
      await post('/__e2e/provisional', { account: 'Chase Prime Visa', date: '2099-10-02', cents: -2000, descriptor: 'ZZ TIP DINNER' });
      const dlg = await openRow('ZZ TIP DINNER');
      const input = await waitFor(() => $('input[aria-label="Tip"]', dlg), 'a Tip box');
      const add = byText('button', /Add tip/, dlg);
      expect(add, 'an Add tip button').to.exist;
      const box = dlg.getBoundingClientRect();
      for (const el of [input, add]) { const r = el.getBoundingClientRect(); expect(r.left).to.be.at.least(box.left); expect(r.right).to.be.at.most(box.right + 0.5); }
      const ri = input.getBoundingClientRect(), ra = add.getBoundingClientRect();
      expect(ri.left < ra.right && ra.left < ri.right && ri.top < ra.bottom && ra.top < ri.bottom, 'tip box runs into its button').to.equal(false);
      setInput(input, '4.00', 'change'); add.click();
      await waitFor(() => /includes a \$4\.00 tip/.test(text($('dialog.txn-detail[open]') ?? document.body)), 'the tip to show in the dialog');
      expect(text($('dialog.txn-detail[open]'))).to.match(/\$24\.00/);
      const t = (await api('/api/transactions?limit=5&q=ZZ%20TIP')).find((x) => x.descriptor_raw === 'ZZ TIP DINNER');
      expect(t).to.include({ amount_cents: -2400, tip_cents: 400 });
      // adding again replaces it, and clearing it puts the original amount back
      setInput($('input[aria-label="Tip"]'), '0', 'change'); byText('button', /Add tip|Update tip|Remove tip/, $('dialog.txn-detail[open]')).click();
      await waitFor(async () => (await api('/api/transactions?limit=5&q=ZZ%20TIP'))[0]?.amount_cents === -2000, 'the tip to come off');
    });

    it('the bank file then pairs with the tipped charge, even when the tip is bigger than the matcher tolerates', async () => {
      await post('/__e2e/provisional', { account: 'Chase Prime Visa', date: '2099-10-02', cents: -1000, descriptor: 'ZZ TIP CAFE' });
      const dlg = await openRow('ZZ TIP CAFE');
      setInput(await waitFor(() => $('input[aria-label="Tip"]', dlg)), '4.00', 'change'); byText('button', /Add tip/, dlg).click();
      await waitFor(async () => (await api('/api/transactions?limit=5&q=ZZ%20TIP'))[0]?.amount_cents === -1400, 'the tip to save');
      const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
      const csv = HDR + '10/02/2099,10/04/2099,ZZ TIP CAFE SEATTLE WA,Food,Sale,-14.00,\n';
      const sug = await post('/api/imports/suggest-mapping', { csv });
      const res = await post('/api/imports/commit', { institution: 'Chase', csv, accountId: chase, spec: { columnMap: sug.columnMap, dateFormat: sug.dateFormat, signRule: sug.signRule, skipRows: 0 } });
      expect(res.supersededProvisionals).to.equal(1);
      const rows = (await api('/api/transactions?limit=10&q=ZZ%20TIP')).filter((r) => r.status !== 'void');
      expect(rows.map((r) => [r.status, r.amount_cents])).to.deep.equal([['posted', -1400]]);
    });

    it('a posted transaction has no tip box', async () => {
      const dlg = await openRow('SAFEWAY');
      await waitFor(() => /Splits/.test(text(dlg)), 'the dialog contents');
      expect($('input[aria-label="Tip"]', dlg)).to.equal(null);
    });
  });
}
