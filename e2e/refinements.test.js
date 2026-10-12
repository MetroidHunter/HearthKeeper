import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep, api, setInput, confirmDialog } from './helpers.js';

const rect = (el) => el.getBoundingClientRect();
const overlap = (a, b) => { const x = rect(a), y = rect(b); return x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom; };

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`UI refinements (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); localStorage.setItem('hk-home-attention-open', '1'); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { $$('dialog').forEach((d) => d.open && d.close()); trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('Needs attention is a compact one-line summary with a chip per open reason', async () => {
      await mount('/');
      const sum = await waitFor(() => $('details.fold .attn-sum'), 'the summary');
      expect(text(sum)).to.match(/\d+ needs? a decision/);
      expect($$('.chip', sum).length).to.be.greaterThan(0);
      expect(text($('details.fold'))).to.not.match(/Waiting on an Amazon/); // the old four-row list is gone
      expect(rect(sum).height, 'summary stays small').to.be.lessThan(label === 'mobile' ? 140 : 70);
      expect(byText('a', /^Backlog$/, sum)).to.exist;
    });

    it('categorizing shows one impact line ending in the new total, and takes a note', async () => {
      await mount('/');
      const card = await waitFor(() => $$('.trow.txn').find((c) => $('button.quick', c) && c.dataset.note === 'missing'), 'a row with a suggestion and no note');
      const id = Number(card.dataset.id);
      $('button.quick', card).click();
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Categorize as/.test(text(d))), 'confirm dialog');
      // read everything off the dialog first and confirm it, so a failing check can never leave a modal open
      const seen = { oldGrid: !!$('.impact', dlg), line: text($('.impact-line', dlg)), hasNew: !!$('.impact-line .impact-new', dlg), right: rect(dlg).right, note: $('.cat-note', dlg) };
      if (seen.note) setInput(seen.note, 'bought for the party');
      await confirmDialog(/Yes, categorize/);
      expect(seen.oldGrid, 'the old before/after grid is gone').to.equal(false);
      expect(seen.line).to.match(/-?\$[\d,]+\.\d\d$/); // ends on the new total
      expect(seen.hasNew).to.equal(true);
      expect(seen.right).to.be.at.most(window.innerWidth);
      expect(seen.note, 'a note field').to.exist;
      await waitFor(async () => (await api('/api/transactions?limit=500')).find((t) => t.id === id)?.note === 'bought for the party', 'the note to be saved with the category');
    });

    it('Budget envelopes can be searched, and clearing the search brings them all back', async () => {
      await mount('/budget');
      const search = await waitFor(() => $('.bsearch'), 'the search box');
      const visible = () => $$('.brow-name, section.group tbody tr b').filter((e) => e.checkVisibility()).map(text);
      await waitFor(() => visible().length > 3, 'envelopes');
      const all = visible().length;
      const target = visible()[0];
      setInput(search, target.slice(0, 4).toUpperCase()); // case-insensitive
      await waitFor(() => visible().length < all && visible().includes(target), 'the list to narrow');
      setInput(search, 'zzzz-no-such-envelope');
      await waitFor(() => /No envelope matches/.test(text($('main'))), 'the empty message');
      expect($$('section.group').length).to.equal(0);
      setInput(search, '');
      await waitFor(() => visible().length === all, 'all envelopes back');
    });

    it('the Add transaction dialog keeps description, amount, category and account from running into each other', async () => {
      await mount('/');
      byText('button', /Add transaction/, await waitFor(() => $('main'))).click();
      const dlg = await waitFor(() => $$('dialog').find((d) => d.open && /Add a transaction/.test(text(d))), 'add dialog');
      const desc = $('input.grow', dlg), amt = $('input.addamt', dlg), cat = $('hk-category-select input', dlg), acct = $('select', dlg);
      for (const [a, b] of [[desc, amt], [cat, amt], [cat, acct], [desc, cat], [amt, acct]]) expect(overlap(a, b), `${a.className || a.tagName} vs ${b.className || b.tagName}`).to.equal(false);
      const box = rect(dlg);
      for (const el of [desc, amt, cat, acct]) { expect(rect(el).left).to.be.at.least(box.left); expect(rect(el).right).to.be.at.most(box.right); }
      byText('button', /^Cancel$/, dlg).click();
    });
  });
}
