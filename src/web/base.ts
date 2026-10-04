import { LitElement } from 'lit';

/** Light-DOM base: pages share the global stylesheet. Pages own their data loading (no view-model layer, design §17.2). */
export class Page extends LitElement {
  createRenderRoot() { return this; }
  protected err = '';
  protected async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try { this.err = ''; const r = await fn(); return r; } catch (e) { this.err = (e as Error).message; return undefined; } finally { this.requestUpdate(); }
  }
}
