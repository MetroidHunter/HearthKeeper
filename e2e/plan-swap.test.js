import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep, api } from './helpers.js';

const month = () => new Date().toISOString().slice(0, 7);
const OLD = ['Eating Out', 'Gas', 'Pets'];
const cat = async (n) => (await api('/api/categories')).find((c) => c.name === n);
const dollars = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dlg = () => $$('dialog').find((d) => d.open && !d.classList.contains('busy'));
const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;

/**
 * A live plan with categories, a brand-new category, then a new plan that sets three old categories to $0 and gives their
 * combined amount to the new one. The history, balances and Budget page must all tell the same story, with and without money in the old envelopes.
 */
for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
  for (const [label, drain] of [['with money left in the old envelopes', false], ['with the old envelopes spent down to $0', true]]) {
    describe(`Folding three categories into a new one ${label} (${name})`, () => {
      let trap;
      beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport({ width, height }); await sleep(100); });
      afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

      it('shows a coherent history and moves the budget, not the money', async () => {
        const acct = (await api('/api/accounts'))[0].id;
        const before = {}; for (const n of OLD) before[n] = await cat(n);
        if (drain) for (const n of OLD) { // spend each envelope to exactly $0 so there is nothing left in it
          const left = (await cat(n)).balance_cents;
          if (left > 0) await api('/api/transactions', { method: 'POST', body: { accountId: acct, descriptor: `DRAIN ${n}`, amountCents: -left, categoryId: before[n].id } });
          expect((await cat(n)).balance_cents).to.equal(0);
        }
        const target = Object.fromEntries((await api('/api/budget')).rows.map((r) => [r.name, r.targetCents]));
        const sum = OLD.reduce((t, n) => t + target[n], 0);
        expect(sum, 'the three have a budget to hand over').to.be.greaterThan(0);

        // a new category: it has no money attached, so it is not on the Budget page yet
        await api('/api/categories', { method: 'POST', body: { name: 'Hobbies', group: 'Fun', startMonth: month() } });
        const hobby = await cat('Hobbies');
        expect((await api('/api/budget')).rows.map((r) => r.name)).to.not.include('Hobbies');
        const allBefore = (await api('/api/categories')).filter((c) => c.kind === 'expense' && !c.system).reduce((t, c) => t + c.balance_cents, 0);
        const allocBefore = (await api('/api/budget')).header.allocatedCents;

        // the new plan, from the live one
        const plan = (await api('/api/plans', { method: 'POST', body: { name: 'Fold into Hobbies', from: 'live' } })).id;
        for (const n of OLD) await api(`/api/plans/${plan}/items/${before[n].id}`, { method: 'PUT', body: { monthlyCents: 0 } });
        await api(`/api/plans/${plan}/items/${hobby.id}`, { method: 'PUT', body: { monthlyCents: sum } });

        // go live through the Plans page and read the diff
        await mount('/plans');
        const planCard = await waitFor(() => $$('.card.row').find((c) => /Fold into Hobbies/.test(text(c))), 'the new plan');
        planCard.click();
        await waitFor(() => byText('button', /Make live/), 'Make live');
        byText('button', /Make live/).click();
        const d = await waitFor(dlg, 'the diff dialog');
        const rows = $$('tbody tr', d).map((r) => $$('td', r).map(text));
        expect(rows.map((r) => r[0]).sort()).to.deep.equal(['Hobbies', ...OLD].sort());
        for (const n of OLD) expect(rows.find((r) => r[0] === n).slice(1, 3), n).to.deep.equal([dollars(target[n]), '$0.00']);
        expect(rows.find((r) => r[0] === 'Hobbies').slice(1, 3)).to.deep.equal(['$0.00', dollars(sum)]);
        expect(text(d)).to.contain('4 history entries');
        expect(d.scrollWidth, 'the dialog does not scroll sideways').to.be.at.most(d.clientWidth + 1);
        byText('button', /^Confirm$/, d).click();
        await waitFor(async () => (await api('/api/budget')).rows.some((r) => r.name === 'Hobbies'), 'Hobbies on the budget');

        // money is conserved: what the old three lost this month, Hobbies gained
        const after = Object.fromEntries((await api('/api/categories')).map((c) => [c.name, c.balance_cents]));
        for (const n of OLD) expect(after[n], n).to.equal(before[n].balance_cents - (drain ? before[n].balance_cents : 0) - target[n]);
        expect(after.Hobbies).to.equal(sum);
        expect((await api('/api/categories')).filter((c) => c.kind === 'expense' && !c.system).reduce((t, c) => t + c.balance_cents, 0)).to.equal(allBefore);
        expect((await api('/api/budget')).header.allocatedCents, 'same total budgeted').to.equal(allocBefore);

        // Budget page: the new one is there with its amount; the old three are still listed (they have history) at $0
        await mount('/budget');
        const list = () => (shown($('.btable')) ? $$('.btable tbody tr') : $$('.brow'));
        await waitFor(() => list().length > 5, 'rows');
        const rowOf = (n) => list().find((r) => text($('b', r)) === n);
        expect(text(rowOf('Hobbies'))).to.contain(dollars(sum));
        for (const n of OLD) expect(rowOf(n), n).to.not.equal(undefined);

        // each category's own history
        for (const n of OLD) {
          await mount(`/categories/${before[n].id}`);
          const hist = await waitFor(() => { const c = $$('.card').find((x) => /Budget history/.test(text(x))); return c && /Fold into Hobbies/.test(text(c)) && c; }, `${n} history`);
          const lines = $$('.row', hist).map(text);
          const last = lines[lines.length - 1];
          expect(last, n).to.contain(month()).and.to.contain(dollars(target[n])).and.to.contain('$0.00').and.to.contain('plan: Fold into Hobbies');
          expect(lines.length, `${n}: earlier entries are kept`).to.be.greaterThan(1);
          expect(text($('b', $$('.card').find((x) => /^Balance/.test(text(x)))))).to.equal(dollars(after[n]));
          expect(document.documentElement.scrollWidth).to.be.at.most(window.innerWidth);
        }
        await mount(`/categories/${hobby.id}`);
        const hh = await waitFor(() => $$('.card').find((x) => /Budget history/.test(text(x)) && /Fold into Hobbies/.test(text(x))), 'Hobbies history');
        const hl = $$('.row', hh).map(text);
        expect(hl).to.have.length(1);
        expect(hl[0]).to.contain(month()).and.to.contain('start').and.to.contain(dollars(sum)).and.to.contain('plan: Fold into Hobbies');
        expect(text($('b', $$('.card').find((x) => /^Balance/.test(text(x)))))).to.equal(dollars(sum));
      });
    });
  }
}
