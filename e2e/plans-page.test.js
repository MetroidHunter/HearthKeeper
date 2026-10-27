import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, setInput, choose, api, sleep } from './helpers.js';

const month = () => new Date().toISOString().slice(0, 7);
const nextMonth = () => { const [y, m] = month().split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const dollars = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
const cat = async (n) => (await api('/api/categories')).find((c) => c.name === n);
const livePlan = async () => (await api('/api/plans')).find((p) => p.phase === 'live');
const dlg = () => $$('dialog').find((d) => d.open && !d.classList.contains('busy'));
const rowOf = (name) => $$('[data-group] tr.prow').find((r) => text($('.cname', r)) === name);
const noSideScroll = () => expect(document.documentElement.scrollWidth, 'no sideways scroll').to.be.at.most(window.innerWidth);

async function draftFromApi(name = 'Next plan') {
  const id = (await api('/api/plans', { method: 'POST', body: { name, from: 'live' } })).id;
  return id;
}

for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
  describe(`Plans page (${name})`, () => {
    let trap; let origPrompt;
    beforeEach(async () => { await reset(); trap = trapErrors(); origPrompt = window.prompt; window.prompt = () => 'E2E plan'; await setViewport({ width, height }); await sleep(100); });
    afterEach(async () => { window.prompt = origPrompt; $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('lists the plans in a standard table, and a row opens that plan on its own page', async () => {
      const draft = await draftFromApi('Table draft');
      await mount('/plans');
      const table = await waitFor(() => $('table.plans-table'), 'the plans table');
      expect($('.card.row'), 'no clickable cards').to.equal(null);
      const heads = $$('thead th', table).map(text);
      for (const h of ['Plan', 'Status', 'Income', 'Allocated', 'Unallocated', 'Goes live']) expect(heads.join('|')).to.contain(h);
      const rows = await waitFor(() => { const r = $$('tbody tr', table); return r.length >= 2 && r; }, 'the plan rows');
      expect(rows.length).to.equal(2);
      const live = rows.find((r) => /Current budget/.test(text(r))); const dr = rows.find((r) => /Table draft/.test(text(r)));
      expect(text(live)).to.match(/live/i); expect(text($('.badge', dr))).to.equal('draft');
      expect(text(live)).to.contain(month()); // the month it went live
      noSideScroll();
      dr.click();
      await waitFor(() => location.hash === `#/plans/${draft}`, 'the plan route');
      await waitFor(() => text($('h1')) === 'Table draft', 'the plan page');
      byText('a', /Plans$/, $('.plan-back')).click();
      await waitFor(() => $('table.plans-table'), 'back on the list');
    });

    it('New from live creates a draft and opens its page; a published plan can be cloned from its row', async () => {
      await mount('/plans');
      byText('button', /New from live/).click();
      await waitFor(() => /#\/plans\/\d+$/.test(location.hash) && $('[data-group]'), 'the new plan page');
      expect(text($('h1'))).to.equal('E2E plan');
      location.hash = '#/plans';
      await waitFor(() => $('table.plans-table'), 'the list');
      const live = await waitFor(() => $$('tbody tr').find((r) => /Current budget/.test(text(r))), 'the live row');
      byText('button', /Clone/, live).click();
      await waitFor(() => /#\/plans\/\d+$/.test(location.hash) && text($('h1')) === 'E2E plan', 'the clone page');
      expect((await api('/api/plans')).length).to.equal(3);
    });

    it('shows the plan grouped like the Budget, with group totals and a pie chart of the same plan', async () => {
      const draft = await draftFromApi();
      await mount(`/plans/${draft}`);
      await waitFor(() => $$('[data-group]').length > 2, 'groups');
      const detail = await api(`/api/plans/${draft}`);
      const byGroup = {};
      for (const i of detail.items) if (i.kind === 'expense') (byGroup[i.group_name ?? 'Other'] ??= []).push(i);
      const pieGroups = Object.entries(byGroup).filter(([, items]) => items.some((i) => i.monthly_cents > 0)).map(([g]) => g);
      expect($$('[data-group]').map((g) => g.dataset.group).sort()).to.deep.equal(Object.keys(byGroup).sort());
      for (const [g, items] of Object.entries(byGroup)) {
        const sec = $(`[data-group="${g}"]`);
        expect(text($('h3', sec)), g).to.contain(dollars(items.reduce((t, i) => t + i.monthly_cents, 0)));
        for (const i of items) expect($$('.cname', sec).map(text), g).to.include(i.name);
      }
      expect(text($('.pstats'))).to.contain(dollars(detail.header.allocatedCents));
      // pie
      const chart = await waitFor(() => $('.chart[data-drawn]'), 'the pie chart');
      expect(chart.clientHeight).to.be.greaterThan(150);
      const list = $$('.pielist .pierow');
      expect(list.map((r) => text($('.pn', r))).sort()).to.deep.equal(pieGroups.sort());
      const total = list.reduce((t, r) => t + Math.round(parseFloat(text($('.pa', r)).replace(/[$,]/g, '')) * 100), 0);
      expect(total, 'the pie adds up to the plan').to.equal(detail.header.allocatedCents);
      if (name === 'mobile') expect(shown($('.pielist'))).to.equal(true);
      // drill into a group
      const food = list.find((r) => text($('.pn', r)) === 'Food'); food.click();
      await waitFor(() => $$('.pielist .pierow').some((r) => text($('.pn', r)) === 'Groceries'), 'categories of Food');
      byText('button', /all groups/).click();
      await waitFor(() => $$('.pielist .pierow').some((r) => text($('.pn', r)) === 'Food'), 'back to groups');
      noSideScroll();
    });

    it('editing an amount on a draft updates the totals and the pie', async () => {
      const draft = await draftFromApi();
      await mount(`/plans/${draft}`);
      await waitFor(() => rowOf('Groceries'), 'rows');
      const before = (await api(`/api/plans/${draft}`)).header.allocatedCents;
      setInput($('input', rowOf('Groceries')), '950.00', 'change');
      await waitFor(() => text($('.pstats')).includes(dollars(before + 15000)), 'new total');
      expect((await api(`/api/plans/${draft}`)).items.find((i) => i.name === 'Groceries').monthly_cents).to.equal(95000);
      expect(text(rowOf('Groceries'))).to.contain(dollars(95000 * 12));
      noSideScroll();
    });

    it('the live plan is read-only: no inputs, no Make live, no editing of actions', async () => {
      const live = await livePlan();
      await mount(`/plans/${live.id}`);
      await waitFor(() => rowOf('Groceries'), 'rows');
      expect($$('[data-group] input')).to.have.length(0);
      expect(byText('button', /Make live/)).to.equal(undefined);
      expect($('.add-move')).to.equal(null);
      expect(text($('.plan-phase'))).to.match(/live/i);
    });

    it('Make live explains what changes and why, in the current month, before anything is changed', async () => {
      const draft = await draftFromApi();
      const g = await cat('Groceries');
      await api(`/api/plans/${draft}/items/${g.id}`, { method: 'PUT', body: { monthlyCents: 95000 } });
      await mount(`/plans/${draft}`);
      await waitFor(() => rowOf('Groceries'), 'rows');
      byText('button', /Make live/).click();
      const d = await waitFor(dlg, 'the dialog');
      const t = text(d);
      expect(t).to.contain('1 history entry will be created');
      expect(t).to.match(/takes effect/i).and.to.contain(month()).and.to.match(/this month/i);
      expect(t).to.match(/why/i);
      expect(t).to.contain('Groceries').and.to.contain(dollars(80000)).and.to.contain(dollars(95000));
      expect(t, 'balance impact of the current month').to.contain('Balance Δ');
      expect(t).to.not.match(/RESTATE/);
      expect(d.scrollWidth).to.be.at.most(d.clientWidth + 1);
      byText('button', /^Cancel$/, d).click();
      await waitFor(() => !dlg(), 'dialog closed');
      expect((await api('/api/budget')).rows.find((r) => r.name === 'Groceries').targetCents, 'cancel changes nothing').to.equal(80000);
      expect((await api(`/api/plans/${draft}`)).plan.status).to.equal('draft');
    });

    it('the go-live month is respected: a plan for next month is scheduled and changes nothing until that month', async () => {
      const draft = await draftFromApi();
      const g = await cat('Groceries');
      await api(`/api/plans/${draft}/items/${g.id}`, { method: 'PUT', body: { monthlyCents: 95000 } });
      await mount(`/plans/${draft}`);
      await waitFor(() => rowOf('Groceries'), 'rows');
      setInput($('input[type=month]'), nextMonth(), 'change');
      byText('button', /Make live/).click();
      const d = await waitFor(dlg, 'the dialog');
      expect(text(d)).to.contain(nextMonth()).and.to.match(/next month/i).and.to.match(/nothing changes today/i);
      expect(text(d)).to.not.contain('Balance Δ');
      byText('button', /^Confirm$/, d).click();
      await waitFor(async () => (await api('/api/plans')).find((p) => p.id === draft).phase === 'scheduled', 'scheduled');
      // today: the old plan, old amounts
      const now = await api('/api/budget');
      expect(now.header.livePlan).to.equal('Current budget');
      expect(now.rows.find((r) => r.name === 'Groceries').targetCents).to.equal(80000);
      // next month: the new plan, new amounts
      const later = await api(`/api/budget?today=${nextMonth()}-02`);
      expect(later.header.livePlan).to.equal('Next plan');
      expect(later.rows.find((r) => r.name === 'Groceries').targetCents).to.equal(95000);
      // the page and the list say so
      await waitFor(() => /scheduled/i.test(text($('.plan-phase'))), 'scheduled badge');
      expect(text($('.plan-phase'))).to.contain(nextMonth());
      location.hash = '#/plans';
      const row = await waitFor(() => $$('tbody tr').find((r) => /Next plan/.test(text(r))), 'list row');
      expect(text(row)).to.match(/scheduled/i).and.to.contain(nextMonth());
      expect(text($$('tbody tr').find((r) => /Current budget/.test(text(r))))).to.match(/live/i);
    });

    it('a scheduled plan can be cancelled: it goes back to a draft and nothing it set remains', async () => {
      const draft = await draftFromApi();
      const g = await cat('Groceries'); const eo = await cat('Eating Out');
      await api(`/api/plans/${draft}/items/${g.id}`, { method: 'PUT', body: { monthlyCents: 95000 } });
      await api(`/api/plans/${draft}/actions`, { method: 'POST', body: { kind: 'move', fromCategoryId: g.id, toCategoryId: eo.id, cents: 1000 } });
      await api(`/api/plans/${draft}/make-live`, { method: 'POST', body: { effectiveMonth: nextMonth() } });
      await mount(`/plans/${draft}`);
      await waitFor(() => /scheduled/i.test(text($('.plan-phase'))), 'scheduled');
      expect(byText('button', /Make live/), 'a scheduled plan is already live').to.equal(undefined);
      byText('button', /Cancel scheduled go-live/).click();
      const d = await waitFor(dlg, 'the confirmation');
      expect(text(d)).to.contain(nextMonth()).and.to.match(/draft/i).and.to.match(/Current budget/);
      expect(d.scrollWidth).to.be.at.most(d.clientWidth + 1);
      byText('button', /^Keep it scheduled$/, d).click();
      await waitFor(() => !dlg(), 'dialog closed');
      expect((await api('/api/plans')).find((p) => p.id === draft).phase, 'keeping it changes nothing').to.equal('scheduled');
      byText('button', /Cancel scheduled go-live/).click();
      byText('button', /^Cancel the go-live$/, await waitFor(dlg, 'confirmation again')).click();
      await waitFor(async () => (await api('/api/plans')).find((p) => p.id === draft).phase === 'draft', 'back to a draft');
      await waitFor(() => /draft/i.test(text($('.plan-phase'))) && byText('button', /Make live/) && $('.add-move'), 'editable again');
      expect((await api(`/api/budget?today=${nextMonth()}-02`)).header.livePlan).to.equal('Current budget');
      expect((await api(`/api/budget?today=${nextMonth()}-02`)).rows.find((r) => r.name === 'Groceries').targetCents).to.equal(80000);
      expect((await api('/api/transfers')).filter((t) => t.kind === 'manual')).to.have.length(0);
      expect((await livePlan()).name).to.equal('Current budget');
      noSideScroll();
    });

    it('a retroactive go-live still needs RESTATE typed', async () => {
      const draft = await draftFromApi();
      const g = await cat('Groceries');
      await api(`/api/plans/${draft}/items/${g.id}`, { method: 'PUT', body: { monthlyCents: 100000 } });
      await mount(`/plans/${draft}`);
      await waitFor(() => rowOf('Groceries'), 'rows');
      setInput($('input[type=month]'), '2026-08', 'change');
      byText('button', /Make live/).click();
      const d = await waitFor(dlg, 'dialog');
      expect(text(d)).to.match(/restates history/i);
      expect(byText('button', /^Confirm$/, d).disabled).to.equal(true);
      setInput($('input', d), 'RESTATE');
      await waitFor(() => !byText('button', /^Confirm$/, dlg()).disabled, 'confirm enabled');
    });

    it('moves money between categories at go-live: add, see it in the dialog, remove one, and it lands when the plan does', async () => {
      const draft = await draftFromApi();
      const [from, to] = [await cat('Groceries'), await cat('Eating Out')];
      await mount(`/plans/${draft}`);
      await waitFor(() => $('.add-move'), 'the actions card');
      // add one with the dialog
      $('.add-move').click();
      let d = await waitFor(dlg, 'the move dialog');
      choose($('select[aria-label="From"]', d), 'Groceries'); choose($('select[aria-label="To"]', d), 'Eating Out');
      setInput($('input[aria-label="Amount"]', d), '25.00');
      byText('button', /^Add move$/, d).click();
      await waitFor(() => $$('.paction').some((a) => /Groceries/.test(text(a)) && /Eating Out/.test(text(a)) && /\$25\.00/.test(text(a))), 'the move is listed');
      // and a throwaway one that is removed again
      $('.add-move').click(); d = await waitFor(dlg, 'dialog 2');
      choose($('select[aria-label="From"]', d), 'Gas'); choose($('select[aria-label="To"]', d), 'Pets'); setInput($('input[aria-label="Amount"]', d), '5');
      byText('button', /^Add move$/, d).click();
      await waitFor(() => $$('.paction').length === 2, 'two actions');
      $('.rm-action', $$('.paction').find((a) => /Gas/.test(text(a)))).click();
      await waitFor(() => $$('.paction').length === 1, 'removed');
      noSideScroll();
      const balBefore = { from: from.balance_cents, to: to.balance_cents };
      byText('button', /Make live/).click();
      d = await waitFor(dlg, 'go-live dialog');
      expect(text(d)).to.contain('Move money').and.to.contain('Groceries').and.to.contain('Eating Out').and.to.contain('$25.00');
      expect(text(d)).to.contain(dollars(balBefore.from - 2500)).and.to.contain(dollars(balBefore.to + 2500));
      expect(text(d)).to.contain(`${month()}-01`);
      byText('button', /^Confirm$/, d).click();
      await waitFor(async () => (await livePlan())?.id === draft, 'plan live');
      expect((await cat('Groceries')).balance_cents).to.equal(balBefore.from - 2500);
      expect((await cat('Eating Out')).balance_cents).to.equal(balBefore.to + 2500);
      // the applied move stays on the page, read-only
      await waitFor(() => $$('.paction').length === 1 && !$('.rm-action') && !$('.add-move'), 'applied actions are read-only');
    });

    it('retires a category at go-live, moving what is left into another', async () => {
      const draft = await draftFromApi();
      const pets = await cat('Pets'); const groceries = await cat('Groceries');
      const pre = (await api(`/api/plans/${draft}/diff?month=${month()}`));
      expect(pre.blockers).to.deep.equal([]);
      await mount(`/plans/${draft}`);
      await waitFor(() => $('.add-retire'), 'retire button');
      $('.add-retire').click();
      let d = await waitFor(dlg, 'retire dialog');
      choose($('select[aria-label="Category"]', d), 'Pets'); choose($('select[aria-label="Move what is left to"]', d), 'Groceries');
      byText('button', /^Add retirement$/, d).click();
      await waitFor(() => $$('.paction').some((a) => /Retire/.test(text(a)) && /Pets/.test(text(a)) && /Groceries/.test(text(a))), 'listed');
      byText('button', /Make live/).click();
      d = await waitFor(dlg, 'go-live dialog');
      const t = text(d);
      expect(t).to.contain('Retire').and.to.contain('Pets').and.to.contain('Groceries').and.to.match(/left in it/i);
      expect(t, 'its budget drops to zero, shown as a change').to.contain(dollars(8000)).and.to.contain('$0.00');
      expect(byText('button', /^Confirm$/, d).disabled).to.equal(false);
      byText('button', /^Confirm$/, d).click();
      await waitFor(async () => (await cat('Pets')).status === 'retired', 'Pets retired');
      expect((await cat('Pets')).balance_cents).to.equal(0);
      expect((await cat('Groceries')).balance_cents).to.be.greaterThan(groceries.balance_cents);
      expect(pets.id).to.be.greaterThan(0);
    });

    it('a retirement for a later month is scheduled with the plan: the category stays active, and nothing moves, until the month arrives', async () => {
      const draft = await draftFromApi();
      const [pets, groceries, eo] = [await cat('Pets'), await cat('Groceries'), await cat('Eating Out')];
      await api(`/api/plans/${draft}/actions`, { method: 'POST', body: { kind: 'retire', categoryId: pets.id, moveBalanceTo: groceries.id } });
      await api(`/api/plans/${draft}/actions`, { method: 'POST', body: { kind: 'move', fromCategoryId: groceries.id, toCategoryId: eo.id, cents: 1000 } });
      await mount(`/plans/${draft}`);
      await waitFor(() => $$('.paction').length === 2, 'actions listed');
      setInput($('input[type=month]'), nextMonth(), 'change');
      byText('button', /Make live/).click();
      const d = await waitFor(dlg, 'dialog');
      const t = text(d);
      expect(t).to.match(/scheduled/i).and.to.contain(`${nextMonth()}-01`).and.to.match(/nothing moves today/i).and.to.match(/stays active/i);
      expect(t).to.not.match(/cannot be retired/i);
      expect(byText('button', /^Confirm$/, d).disabled).to.equal(false);
      expect(d.scrollWidth).to.be.at.most(d.clientWidth + 1);
      byText('button', /^Confirm$/, d).click();
      await waitFor(async () => (await api('/api/plans')).find((p) => p.id === draft).phase === 'scheduled', 'scheduled');
      expect((await cat('Pets')).status, 'still active until the month').to.equal('active');
      expect((await api('/api/transfers')).filter((x) => x.kind === 'manual')).to.have.length(0);
      await waitFor(() => $$('.paction').length === 2 && $$('.paction').every((a) => /scheduled for/.test(text(a)) && text(a).includes(`${nextMonth()}-01`)), 'actions show as scheduled');
      expect($('.rm-action'), 'no longer editable').to.equal(null);
      noSideScroll();
    });
  });
}
