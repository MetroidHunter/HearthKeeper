import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, trapErrors, sleep, api } from './helpers.js';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Months explains what is netted into Spent (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('a refund booked to an expense envelope is shown as a credit that lowers Spent, with its description', async () => {
      const cats = await api('/api/categories'); const fees = cats.find((c) => c.name === 'Fees and Taxes') ?? cats.find((c) => c.kind === 'expense');
      const acct = (await api('/api/accounts'))[0].id;
      await api('/api/transactions', { method: 'POST', body: { accountId: acct, occurredOn: '2026-03-20', descriptor: 'IRS TREAS 310 TAX REF', amountCents: 400000, categoryId: fees.id } });
      const months = await api('/api/months');
      const stats = months.find((m) => m.month === '2026-03').stats;
      expect(stats.credits.cents).to.be.at.least(400000);
      await mount('/months');
      const card = await waitFor(() => $('details.month[data-month="2026-03"]'), 'the March card');
      card.open = true;
      const line = await waitFor(() => $('.mcredits', card), 'the credits explanation');
      expect(text(line)).to.include('IRS TREAS 310 TAX REF');
      expect(text(line)).to.include('$4,000.00');
      expect(text(line)).to.match(/money out/i);
      expect(text(line)).to.match(/credits?/i);
      const r = line.getBoundingClientRect(); expect(r.right).to.be.at.most(window.innerWidth);
    });

    it('a month with no credits shows no such line', async () => {
      await mount('/months');
      const cards = await waitFor(() => $$('details.month').length && $$('details.month'), 'months');
      const clean = (await api('/api/months')).find((m) => m.stats.credits.count === 0);
      if (!clean) return;
      const card = $(`details.month[data-month="${clean.month}"]`); if (!card) return; card.open = true;
      expect($('.mcredits', card)).to.not.exist;
    });
  });
}
