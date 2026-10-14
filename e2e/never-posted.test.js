import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, trapErrors, sleep, api } from './helpers.js';

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify(body) }).then((r) => r.json());
const HDR = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`"Never posted" follows the bank uploads (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '1'); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    const upload = async (rows) => {
      const csv = HDR + rows.join('\n') + '\n'; const chase = (await api('/api/accounts')).find((a) => a.name === 'Chase Prime Visa').id;
      const sug = await post('/api/imports/suggest-mapping', { csv });
      return post('/api/imports/commit', { institution: 'Chase', csv, accountId: chase, spec: { columnMap: sug.columnMap, dateFormat: sug.dateFormat, signRule: sug.signRule, skipRows: 0 } });
    };
    const staleNames = async () => (await api('/api/inbox')).staleProvisionals.map((t) => t.descriptor_raw);

    it('a $10 charge on 10/02 is only "never posted" once a later Chase upload leaves it out', async () => {
      await post('/__e2e/provisional', { account: 'Chase Prime Visa', date: '2099-10-02', cents: -1000, descriptor: 'ZZ COFFEE ALERT' });
      // 1. no upload covers it yet
      await post('/api/maintenance/stale', {});
      expect(await staleNames(), 'no upload at all').to.not.include('ZZ COFFEE ALERT');
      // 2. an upload that ends the day before: still just pending
      await upload(['10/01/2099,10/01/2099,SOME OTHER SHOP,Shopping,Sale,-5.00,']);
      await post('/api/maintenance/stale', {});
      expect(await staleNames(), 'the last upload ends before 10/02').to.not.include('ZZ COFFEE ALERT');
      await mount('/');
      await waitFor(() => $$('.trow.txn').length > 0, 'Home to load');
      expect($$('[data-stale]').filter((e) => /ZZ COFFEE ALERT/.test(text(e.closest('.trow') ?? e)))).to.have.length(0);
      // 3. a later upload that still does not contain it: now it is overdue
      await upload(['10/05/2099,10/05/2099,ANOTHER SHOP,Shopping,Sale,-7.00,']);
      expect(await staleNames(), 'a later upload posted newer charges without it').to.include('ZZ COFFEE ALERT');
      await mount('/');
      const row = await waitFor(() => $$('.trow.txn').find((r) => /ZZ COFFEE ALERT/.test(text(r))), 'the overdue charge on Home');
      const chip = $('[data-stale]', row);
      expect(chip, 'a Never posted chip').to.exist; expect(text(chip)).to.equal('Never posted');
      const r = chip.getBoundingClientRect(); expect(r.right).to.be.at.most(window.innerWidth);
    });

    it('an upload in another account does not make a Chase charge overdue', async () => {
      await post('/__e2e/provisional', { account: 'Chase Prime Visa', date: '2099-10-02', cents: -1000, descriptor: 'ZZ OTHER ACCOUNT' });
      const wf = (await api('/api/accounts')).find((a) => /Wells Fargo/.test(a.name)); const csv = HDR + '10/09/2099,10/09/2099,WF ROW,Shopping,Sale,-3.00,\n';
      const sug = await post('/api/imports/suggest-mapping', { csv });
      await post('/api/imports/commit', { institution: 'Wells Fargo', csv, accountId: wf.id, spec: { columnMap: sug.columnMap, dateFormat: sug.dateFormat, signRule: sug.signRule, skipRows: 0 } });
      await post('/api/maintenance/stale', {});
      expect(await staleNames()).to.not.include('ZZ OTHER ACCOUNT');
    });
  });
}
