import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, text, trapErrors, sleep } from './helpers.js';

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hearthkeeper' }, body: JSON.stringify(body) });

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Over-budget heads-up shows a real amount (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('an amount stored with unrounded cents is shown as whole cents', async () => {
      await post('/__e2e/notice', { message: 'Makeup went over budget: -$49.19.773092000046745 left in it after SEPHORA SOUTHCENTER ($83.91) was filed there automatically.' });
      await mount('/');
      const n = await waitFor(() => $('.notice'), 'the heads-up');
      expect(text(n)).to.include('Makeup is $49.20 over budget after SEPHORA SOUTHCENTER ($83.91).');
      expect(text(n), 'no stray fractional cents').to.not.match(/\.\d{2}\.\d/);
      expect(n.getBoundingClientRect().right).to.be.at.most(window.innerWidth);
      const msg = $('.grow', n).getBoundingClientRect(); const lineHeight = parseFloat(getComputedStyle($('.grow', n)).lineHeight) || 24;
      expect(msg.height, 'the message takes at most two lines, not a column squeezed by the buttons').to.be.at.most(lineHeight * 2 + 4);
      expect(n.getBoundingClientRect().height, 'a compact heads-up').to.be.at.most(label === 'mobile' ? 130 : 80);
    });
  });
}
