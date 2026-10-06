import type * as Echarts from 'echarts/core';

/** ECharts is ~400 KB, so it loads on first use only (the phone Home never pays for it). */
let loading: Promise<typeof Echarts> | null = null;
export function loadCharts(): Promise<typeof Echarts> {
  loading ??= (async () => {
    const [core, charts, comps, rend] = await Promise.all([import('echarts/core'), import('echarts/charts'), import('echarts/components'), import('echarts/renderers')]);
    core.use([charts.BarChart, charts.LineChart, charts.PieChart, charts.TreemapChart, charts.HeatmapChart,
      comps.GridComponent, comps.TooltipComponent, comps.LegendComponent, comps.VisualMapComponent, comps.DatasetComponent, rend.CanvasRenderer]);
    return core;
  })();
  return loading;
}

/** Brand-neutral categorical palette, readable in light and dark. */
export const PALETTE = ['#2f7f6c', '#d98e2b', '#4a78b8', '#b8506b', '#7c62b3', '#4f9a3f', '#c46a2e', '#3a9bad', '#8a7a2b', '#a45ab0', '#6b7b8c', '#c2563f'];

export function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  return { ink: v('--ink', '#1d2421'), muted: v('--muted', '#6b756f'), line: v('--line', '#e1ddd2'), brand: v('--brand', '#1f6f5c'), bad: v('--bad', '#b3261e') };
}

const live = new WeakMap<HTMLElement, { chart: Echarts.ECharts; ro: ResizeObserver; redraw?: () => void }>();
const redraws = new Set<() => void>(); // charts redraw with the new colors when the theme changes
addEventListener('hk-theme', () => redraws.forEach((r) => r()));
/** Draw (or redraw) an option into an element; handles resize and disposal. Returns the chart so callers can attach click handlers. */
export async function draw(el: HTMLElement, option: Echarts.EChartsCoreOption, onClick?: (p: any) => void) {
  const e = await loadCharts();
  let h = live.get(el);
  if (!h) { const chart = e.init(el); const ro = new ResizeObserver(() => chart.resize()); ro.observe(el); h = { chart, ro }; live.set(el, h); }
  const apply = () => { const t = theme(); h!.chart.setOption({ textStyle: { color: t.ink }, color: PALETTE, ...option }, true); };
  apply();
  if (h.redraw) redraws.delete(h.redraw);
  h.redraw = () => { if (el.isConnected) apply(); else redraws.delete(h!.redraw!); }; redraws.add(h.redraw);
  h.chart.off('click'); if (onClick) h.chart.on('click', onClick);
  el.dataset.drawn = '1';
  return h.chart;
}
export function dispose(el: HTMLElement) { const h = live.get(el); if (h) { if (h.redraw) redraws.delete(h.redraw); h.ro.disconnect(); h.chart.dispose(); live.delete(el); } }
