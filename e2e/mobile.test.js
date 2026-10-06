import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, sleep } from './helpers.js';

const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;

describe('Budget on a phone (390px wide)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); try { localStorage.removeItem('hk-intro-open'); } catch { /* none */ } await setViewport({ width: 390, height: 844 }); await sleep(100); });
  afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

  it('categories are two-line rows (no six-column table), nothing scrolls sideways, and the controls work', async () => {
    await mount('/budget');
    await waitFor(() => $$('.brow').length > 10, 'rows');
    expect($$('.btable').every((t) => !shown(t)), 'the desktop table is hidden').to.equal(true);
    expect(document.documentElement.scrollWidth, 'no horizontal page scroll').to.be.at.most(window.innerWidth);
    const row = $$('.brow').find((r) => /Groceries/.test(text(r)));
    expect(text($('.brow-name', row))).to.equal('Groceries');
    expect(text(row)).to.match(/\$800\.00/); // target
    const name = $('.brow-name', row).getBoundingClientRect(), bal = $('.brow-bal', row).getBoundingClientRect();
    expect(name.height, 'the name is on one line').to.be.below(30);
    expect(bal.right, 'balance stays inside the card').to.be.at.most(window.innerWidth);
    for (const b of [$('.bfav', row), $('.bedit', row)]) { const r = b.getBoundingClientRect(); expect(r.width, 'tap target width').to.be.at.least(30); expect(r.height, 'tap target height').to.be.at.least(28); }
    // the pencil opens the edit dialog without navigating
    $('.bedit', row).click();
    await waitFor(() => $('dialog[open]'), 'edit dialog');
    expect(location.hash).to.equal('#/budget');
    const dlg = $('dialog[open]').getBoundingClientRect(); expect(dlg.left).to.be.at.least(0); expect(dlg.right).to.be.at.most(window.innerWidth);
    byText('button', /^Cancel$/, $('dialog[open]')).click();
    // tapping the row goes to the category
    row.click(); await waitFor(() => /#\/categories\/\d+/.test(location.hash), 'category page');
  });

  it('the page explanation starts folded on a phone and remembers when you open it', async () => {
    await mount('/budget');
    const intro = $('.intro');
    expect(intro.open).to.equal(false);
    expect(intro.getBoundingClientRect().height, 'folded to one line').to.be.below(60);
    expect(shown($('summary', intro))).to.equal(true);
    $('summary', intro).click();
    await waitFor(() => $('.intro').open, 'opened');
    expect($('.intro').getBoundingClientRect().height, 'unfolded').to.be.above(120);
    await waitFor(() => localStorage.getItem('hk-intro-open') === '1', 'remembered');
    await mount('/backlog'); // another page: still open
    expect($('.intro').open).to.equal(true);
  });

  it('pie: no clipped labels; a legend lists every group with amount and share, and tapping drills in', async () => {
    await mount('/budget');
    await waitFor(() => $$('.brow').length > 5, 'budget');
    byText('button', /^Pie$/).click();
    const canvas = await waitFor(() => $('.chart canvas'), 'pie canvas');
    const card = $('.chart').closest('.card').getBoundingClientRect();
    expect(canvas.getBoundingClientRect().right, 'chart inside the card').to.be.at.most(card.right + 1);
    expect(canvas.getBoundingClientRect().left).to.be.at.least(card.left - 1);
    const rows = await waitFor(() => { const r = $$('.pierow'); return r.length > 3 && r; }, 'legend rows');
    expect(rows.every(shown)).to.equal(true);
    expect(document.documentElement.scrollWidth).to.be.at.most(window.innerWidth);
    for (const r of rows) { const b = r.getBoundingClientRect(); expect(b.right, 'legend row inside the screen').to.be.at.most(window.innerWidth); expect(b.height).to.be.at.least(40); expect(text(r)).to.match(/\$[\d,]+\.\d{2}.*%$/); }
    const pct = rows.map((r) => parseFloat(text($('.pp', r)))).reduce((a, b) => a + b, 0);
    expect(pct).to.be.within(99, 101);
    const food = rows.find((r) => /^Food/.test(text(r))); food.click();
    await waitFor(() => $$('.pierow').some((r) => /Groceries/.test(text(r))), 'drilled into Food');
    expect($$('.pierow').some((r) => /Mortgage/.test(text(r)))).to.equal(false);
    byText('button', /all groups/).click();
    await waitFor(() => $$('.pierow').some((r) => /^Food/.test(text(r))), 'back to groups');
  });

  it('Months fits a phone: cards wrap, nothing scrolls sideways, fix links are tappable', async () => {
    await mount('/months');
    await waitFor(() => $$('details.month').length > 0, 'month cards');
    expect(document.documentElement.scrollWidth, 'no horizontal page scroll').to.be.at.most(window.innerWidth);
    for (const c of $$('details.month')) { const r = c.getBoundingClientRect(); expect(r.right, 'card inside the screen').to.be.at.most(window.innerWidth); expect(r.left).to.be.at.least(0); }
    const open = $$('details.month').find((c) => c.open && $('a.mfix', c));
    if (open) { const a = $('a.mfix', open).getBoundingClientRect(); expect(a.height, 'tap target').to.be.at.least(28); expect(a.right).to.be.at.most(window.innerWidth); }
  });
});
