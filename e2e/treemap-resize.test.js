import { setViewport } from '@web/test-runner-commands';
import { expect, mount, reset, waitFor, $, trapErrors, sleep, choose, api } from './helpers.js';

for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
  describe(`Analytics treemap keeps its container steady when the range changes (${label})`, () => {
    let trap, realFetch;
    beforeEach(async () => { await reset(); trap = trapErrors(); realFetch = window.fetch; await setViewport(size); await sleep(100); });
    afterEach(async () => { window.fetch = realFetch; trap.stop(); expect(trap.errs).to.deep.equal([]); await setViewport({ width: 800, height: 600 }); });

    it('the container never shrinks and re-grows while data loads, and the blocks always fill the canvas', async () => {
      // spending that exists only further back, so each longer range brings in new groups and categories
      const cats = (await api('/api/categories')).filter((c) => c.kind === 'expense'); const acct = (await api('/api/accounts'))[0].id;
      const back = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
      for (const [i, c] of cats.entries()) for (const n of [2, 5, 9, 14, 20, 30, 45, 55]) if ((i + n) % 3) await api('/api/transactions', { method: 'POST', body: { accountId: acct, occurredOn: back(n), descriptor: `OLD ${c.name} ${n}`, amountCents: -(1000 * (i + 1) * (n % 7 + 1)), categoryId: c.id } });
      await mount('/analytics');
      (await waitFor(() => $('button[data-tab=bva]'), 'the first tab')).click(); await sleep(600); // arrive from a tall chart
      (await waitFor(() => $('button[data-tab=tree]'), 'treemap tab')).click();
      const el = await waitFor(() => $('.chart canvas') && $('.chart'), 'the treemap');
      const echarts = await import('echarts/core');
      const probe = () => {
        const chart = echarts.getInstanceByDom(el); const series = chart.getModel().getSeriesByIndex(0); const root = series.getViewRoot().getLayout();
        let leafArea = 0, outside = 0;
        const walk = (n) => { if (!n.children?.length) { const l = n.getLayout(); if (l && l.width) { leafArea += l.width * l.height; if (l.x < -1 || l.y < -1 || l.x + l.width > root.width + 1 || l.y + l.height > root.height + 1) outside++; } } else n.children.forEach(walk); };
        walk(series.getViewRoot());
        return { canvasW: chart.getWidth(), canvasH: chart.getHeight(), w: el.clientWidth, h: el.clientHeight, coverage: leafArea / (root.width * root.height), outside };
      };
      await sleep(500);
      const settled = probe(); const steadyHeight = settled.h;
      window.fetch = async (...a) => { if (String(a[0]).includes('analytics/treemap')) await sleep(350); return realFetch(...a); }; // a real network is not instant
      for (const n of ['24 months', '6 months', '60 months', '12 months']) {
        choose(await waitFor(() => $('select'), 'the range select'), n);
        for (let i = 0; i < 14; i++) { // through the whole load, redraw and settle
          await sleep(60); const p = probe();
          expect(p.h, `${n}: the container height must not change while loading (t+${(i + 1) * 60}ms)`).to.equal(steadyHeight);
          expect(p.canvasH, `${n}: canvas matches its container (t+${(i + 1) * 60}ms)`).to.equal(p.h);
          expect(p.canvasW).to.equal(p.w);
        }
        const p = probe();
        expect(p.coverage, `${n}: the blocks fill the treemap, no white space`).to.be.within(0.97, 1.03);
        expect(p.outside, `${n}: blocks outside the treemap`).to.equal(0);
      }
    });
  });
}
