import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, trapErrors, api } from './helpers.js';

for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
  describe(`Category page and Budget order (${name})`, () => {
    let trap;
    beforeEach(async () => { await reset(); await setViewport({ width, height }); trap = trapErrors(); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });
    const cat = async (n) => (await api('/api/categories')).find((c) => c.name === n);

    it('Rules pointing here show what the rule matches, not its note or origin', async () => {
      const g = await cat('Groceries');
      await api('/api/rules', { method: 'POST', body: { match: { all_of: [{ field: 'descriptor', op: 'contains', value: 'TRADER JOE' }, { field: 'amount_abs', op: 'gte', value: 2000 }] }, action: { type: 'categorize', category: 'Groceries' }, mode: 'auto', notes: 'from merchant history' } });
      await mount(`/categories/${g.id}`);
      const rule = await waitFor(() => $$('.cat-rule').find((r) => /TRADER JOE/.test(text(r))), 'the new rule line');
      expect(text(rule)).to.contain('TRADER JOE').and.to.contain('$20.00');
      expect(text(rule)).to.not.match(/from merchant history|rule #/);
    });

    it('the balance card lays transactions, transfers and accrued out as labelled figures', async () => {
      const g = await cat('Groceries');
      await mount(`/categories/${g.id}`);
      const parts = await waitFor(() => { const p = $$('.bal-parts > div'); return p.length === 3 && p; }, 'three balance parts');
      expect(parts.map((p) => text($('.muted', p)).toLowerCase())).to.deep.equal(['transactions', 'transfers', 'accrued']);
      for (const p of parts) expect(text($('b', p))).to.match(/^-?\$[\d,]+\.\d\d$/);
      expect(text($$('.card').find((c) => /Balance/.test(text(c))))).to.not.contain('·');
    });

    it('Budget leads with Negative balance (needs fixing), then Over monthly budget (spent more than this month\'s amount, still has money)', async () => {
      const month = new Date().toISOString().slice(0, 7);
      const gas = await cat('Gas'), groceries = await cat('Groceries');
      await api(`/api/categories/${gas.id}/budget`, { method: 'POST', body: { monthlyCents: 100, effectiveMonth: month } });
      await api('/api/transfers/adjustment', { method: 'POST', body: { categoryId: groceries.id, cents: -100000000, reason: 'test: push below zero' } });
      const rows = (await api('/api/budget')).rows;
      const negative = rows.filter((r) => r.currentCents < 0).map((r) => r.name);
      const over = rows.filter((r) => r.currentCents >= 0 && r.kind === 'expense' && r.spent[0] > r.targetCents).map((r) => r.name);
      expect(negative, 'Groceries is below zero').to.include('Groceries');
      expect(over, 'Gas is over its monthly amount but not negative').to.include('Gas');
      expect(rows.find((r) => r.name === 'Gas').currentCents).to.be.at.least(0);
      await mount('/budget');
      const groups = await waitFor(() => { const g = $$('section.group'); return g.length > 2 && g; }, 'groups');
      expect(groups[0].dataset.group).to.equal('Negative balance');
      expect(groups[1].dataset.group).to.equal('Over monthly budget');
      const names = (g) => $$('tbody tr b', g).map((b) => text(b)).sort();
      expect(names(groups[0])).to.deep.equal([...negative].sort());
      expect(names(groups[1])).to.deep.equal([...over].sort());
      const others = groups.slice(2).flatMap(names);
      for (const n of [...negative, ...over]) expect(others).to.not.include(n);
      expect($('.group-note', groups[0]), 'the negative group explains itself').to.exist;
      expect($('.group-note', groups[1]), 'the overspent group explains itself').to.exist;
    });

    it('a negative envelope that is also over its monthly amount appears once, under Negative balance', async () => {
      const groceries = await cat('Groceries');
      await api('/api/transfers/adjustment', { method: 'POST', body: { categoryId: groceries.id, cents: -100000000, reason: 'test: push below zero' } });
      const g = await cat('Groceries');
      await api(`/api/categories/${g.id}/budget`, { method: 'POST', body: { monthlyCents: 1, effectiveMonth: new Date().toISOString().slice(0, 7) } });
      await mount('/budget');
      const groups = await waitFor(() => { const x = $$('section.group'); return x.length > 1 && x; }, 'groups');
      const where = groups.filter((s) => $$('tbody tr b', s).some((b) => text(b) === 'Groceries')).map((s) => s.dataset.group);
      expect(where).to.deep.equal(['Negative balance']);
    });

    it('no Negative balance group when nothing is below zero', async () => {
      await mount('/budget');
      await waitFor(() => $$('section.group').length > 1, 'groups');
      const rows = (await api('/api/budget')).rows;
      if (rows.some((r) => r.currentCents < 0)) return; // demo data already has one: covered above
      expect($$('section.group').map((s) => s.dataset.group)).to.not.include('Negative balance');
    });
  });
}
