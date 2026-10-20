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

    it('Budget lists envelopes that are over this month first, in an Over budget group', async () => {
      const gas = await cat('Gas');
      await api(`/api/categories/${gas.id}/budget`, { method: 'POST', body: { monthlyCents: 100, effectiveMonth: new Date().toISOString().slice(0, 7) } });
      const budget = await api('/api/budget');
      const over = budget.rows.filter((r) => r.kind === 'expense' && r.spent[0] > r.targetCents).map((r) => r.name);
      expect(over, 'demo data has something over').to.include('Gas');
      await mount('/budget');
      const first = await waitFor(() => $('section.group'), 'groups');
      expect(first.dataset.group).to.equal('Over budget');
      const names = $$('tbody tr b', first).map((b) => text(b));
      expect(names.sort()).to.deep.equal([...over].sort());
      const others = $$('section.group').slice(1).flatMap((s) => $$('tbody tr b', s).map((b) => text(b)));
      for (const n of over) expect(others).to.not.include(n);
    });
  });
}
