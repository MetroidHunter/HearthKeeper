import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, choose, sleep } from './helpers.js';

describe('Analytics (chart catalog)', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  const tab = async (key) => { byText('button', new RegExp(`^${key}$`)).click(); await waitFor(() => $('.chart')?.dataset.drawn === '1' && $('.chart canvas'), `${key} chart`); };

  it('every tab draws a real chart from live data', async function () {
    this.timeout(60000); // the first run of the whole suite makes the dev server transform ECharts cold, which can take well over 8s
    await mount('/analytics');
    await waitFor(() => $('.chart canvas'), 'first chart (lazy ECharts load)', 40000);
    for (const t of ['Spend over time', 'Treemap', 'Category trend', 'Income vs spend', 'Merchants']) { await tab(t); expect($('.chart canvas').width).to.be.greaterThan(100); }
  });

  it('each chart starts at its own height: a tall chart (Budget vs actual, Treemap, Merchants) never leaves its height on the Category trend', async function () {
    this.timeout(60000);
    await mount('/analytics');
    await waitFor(() => $('.chart canvas'), 'first chart (lazy ECharts load)', 40000);
    const h = () => Math.round($('.chart').getBoundingClientRect().height);
    expect(h(), 'Budget vs actual is as tall as its rows need').to.be.greaterThan(400);
    for (const before of ['Budget vs actual', 'Treemap', 'Merchants', 'Spend over time']) {
      await tab(before);
      await tab('Category trend');
      expect(h(), `Category trend after ${before}`).to.equal(380);
    }
  });

  it('the year pivot is a table that matches the API', async () => {
    await mount('/analytics');
    byText('button', /^Year pivot$/).click();
    await waitFor(() => $$('table tbody tr').length > 0, 'pivot rows');
    const api_ = await api('/api/analytics/year-pivot');
    expect($$('table tbody tr').length).to.equal(api_.rows.length);
  });

  it('clicking a bar drills down to the transactions behind it', async () => {
    await mount('/analytics');
    const canvas = await waitFor(() => $('.chart canvas'), 'budget-vs-actual chart');
    const echarts = await import('echarts/core');
    const chart = echarts.getInstanceByDom($('.chart'));
    const rows = (await api('/api/analytics/budget-vs-actual')).reverse();
    const idx = rows.length - 1; // the biggest budget is drawn at the top
    const [px, py] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [rows[idx].budget / 2, rows[idx].name]);
    const r = canvas.getBoundingClientRect();
    for (const type of ['mousedown', 'mouseup', 'click']) canvas.dispatchEvent(new MouseEvent(type, { clientX: r.left + px, clientY: r.top + py, bubbles: true }));
    await waitFor(() => /^#\/transactions\?category=\d+/.test(location.hash), 'drill-down navigation');
    expect(location.hash).to.contain('from=');
    await waitFor(() => /Showing/.test(text(document.body)), 'filtered transactions page');
  });
});
