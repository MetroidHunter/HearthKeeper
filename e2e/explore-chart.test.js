import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, trapErrors, sleep, setInput } from './helpers.js';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Explore search chart shows dollars, not cents (${label})`, () => {
    let trap;
    beforeEach(async () => { await reset(); trap = trapErrors(); await setViewport(size); await sleep(100); });
    afterEach(async () => { trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('the tooltip and the axis format cents as money', async () => {
      await mount('/explore');
      setInput(await waitFor(() => $('input[type=search]'), 'search box'), 'safeway');
      $('input[type=search]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const el = await waitFor(() => $('.chart canvas') && $('.chart'), 'the chart');
      const { loadCharts } = await import('../src/web/charts.ts');
      const opt = (await loadCharts()).getInstanceByDom(el).getOption();
      const tip = opt.tooltip[0].formatter;
      expect(typeof tip, 'the tooltip has a money formatter').to.equal('function');
      const shown = String(tip([{ name: '2026-09', value: 1234567, axisValueLabel: '2026-09', marker: '' }]));
      expect(shown).to.include('$12,345.67');
      expect(shown).to.not.include('1234567');
      const axis = opt.yAxis[0].axisLabel.formatter;
      expect(axis(1234567)).to.equal('$12,346');
      expect(axis(0)).to.equal('$0');
    });
  });
}
