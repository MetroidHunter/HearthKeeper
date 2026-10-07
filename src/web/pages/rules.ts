import { html, nothing } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { customElement, state } from 'lit/decorators.js';
import { Page } from '../base.js';
import { api } from '../api.js';
import { type Cat } from '../shared.js';
import { ruleBuilder, clausesValid, matchFromClauses, type RuleClause } from '../txn.js';
import { pageHead, th, catSelect, showDialog, promptBox, confirmBox, toast } from '../ui.js';

const PAGE = 50;
/** Rules and merchants. The household has thousands of merchants, so lists are paged and searched on the server; only 50 rows are ever in the DOM. */
@customElement('hk-rules')
export class Rules extends Page {
  @state() rules: any[] = []; @state() merch: { rows: any[]; total: number; unreviewed: number; withoutHistory: number } = { rows: [], total: 0, unreviewed: 0, withoutHistory: 0 }; @state() cats: Cat[] = [];
  @state() tab: 'rules' | 'merchants' = 'rules';   @state() rq = ''; @state() rpage = 0; @state() showOff = false; @state() mq = ''; @state() mpage = 0; @state() onlyNew = true; /* true = only shops with no usual category yet */
  private timer: any;
  connectedCallback() { super.connectedCallback(); this.load(); }
  async load() { await this.run(async () => { [this.rules, this.cats] = await Promise.all([api.get('/api/rules'), api.get('/api/categories')]); await this.loadMerchants(); }); }
  async loadMerchants() { this.merch = await api.get(`/api/merchants?limit=${PAGE}&offset=${this.mpage * PAGE}${this.mq ? `&q=${encodeURIComponent(this.mq)}` : ''}${this.onlyNew ? '&review=nohistory' : ''}`); }
  summary(r: any) {
    const usd = (n: number) => `$${(n / 100).toFixed(2)}`;
    const one = (c: any) => c.field === 'amount_abs' ? `amount ${({ eq: 'is', gte: '≥', lte: '≤', between: 'between' } as any)[c.op] ?? c.op} ${c.op === 'between' ? `${usd(c.value[0])} and ${usd(c.value[1])}` : usd(c.value)}`
      : `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
    try { return JSON.parse(r.match_json).all_of.map((c: any) => (c.any_of ? `(${c.any_of.map(one).join(' OR ')})` : one(c))).join(' AND '); } catch { return ''; }
  }
  act(r: any) { const a = JSON.parse(r.action_json); return a.type === 'categorize' ? a.category : a.type; }
  render() {
    return html`${pageHead('Rules & merchants', 'Rules are decisions you made and keep: "when the description contains X, use category Y". Merchants are only a memory of what you have chosen before; they suggest, and never decide.', 'Make a rule with "New rule", or while categorizing by ticking "Make a rule" in the confirmation dialog. When a rule and a merchant disagree, the rule wins, and both answers are offered as buttons. A merchant you keep choosing the same thing for can be turned into a rule here with "Make a rule…".')}
      ${this.err ? html`<p class="err">${this.err}</p>` : nothing}
      <div class="tabs"><button aria-pressed=${this.tab === 'rules'} @click=${() => (this.tab = 'rules')}>Rules (${this.rules.filter((r) => r.enabled).length}${this.rules.some((r) => !r.enabled) ? ` of ${this.rules.length}` : ''})</button><button aria-pressed=${this.tab === 'merchants'} @click=${() => (this.tab = 'merchants')}>Merchants</button></div>
      ${this.tab === 'rules' ? this.rulesTab() : this.merchantsTab()}`;
  }
  pager(page: number, total: number, set: (n: number) => void) {
    const last = Math.max(0, Math.ceil(total / PAGE) - 1);
    return html`<div class="pager"><button ?disabled=${page <= 0} @click=${() => set(page - 1)}>← Previous</button><span class="muted">${total === 0 ? 'No results' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total.toLocaleString()}`}</span><button ?disabled=${page >= last} @click=${() => set(page + 1)}>Next →</button></div>`;
  }
  rulesTab() {
    const q = this.rq.toLowerCase();
    const off = this.rules.filter((r) => !r.enabled).length;
    // disabled rules are hidden unless asked for, and always sort below the active ones (the API already orders by priority within each group)
    const list = this.rules.filter((r) => (this.showOff || r.enabled) && (!q || `${this.summary(r)} ${this.act(r)} ${r.notes ?? ''}`.toLowerCase().includes(q))).sort((a, b) => Number(!!b.enabled) - Number(!!a.enabled));
    const rows = list.slice(this.rpage * PAGE, (this.rpage + 1) * PAGE);
    return html`<div class="row"><input class="grow" type="search" placeholder="Filter rules" .value=${this.rq} @input=${(e: any) => { this.rq = e.target.value; this.rpage = 0; }} />${off ? html`<label><input type="checkbox" id="show-off" .checked=${this.showOff} @change=${(e: any) => { this.showOff = e.target.checked; this.rpage = 0; }} /> Show disabled (${off})</label>` : nothing}<button class="primary new-rule" @click=${() => this.newRule()}>＋ New rule</button></div>
      <p class="muted small" style="margin:0">When more than one rule matches, the <b>lowest priority number</b> wins. Rules with the same number are ranked by how many conditions they have (more specific wins); a tie with different categories is left for you to decide.</p>
      <div class="card flush" style="overflow-x:auto"><table><thead><tr>${th('Pri', 'Priority: lower numbers are checked first; the most specific rule wins ties.')}${th('Match', 'The condition on the transaction.')}${th('→', 'The category it assigns.')}${th('Mode', 'auto: applies silently. suggest: offers it. ask: always asks.')}${th('Hits', 'How many transactions this rule has matched.', 'num')}<th></th></tr></thead><tbody>
        ${rows.map((r) => html`<tr style=${r.enabled ? '' : 'opacity:.5'}><td><input class="rule-pri" type="number" min="1" max="9999" step="1" aria-label="Priority (lower is checked first)" .value=${String(r.priority)} @change=${async (e: any) => { const n = Number(e.target.value); if (!Number.isInteger(n) || n < 1 || n > 9999) { toast('Priority is a whole number from 1 to 9999'); e.target.value = String(r.priority); return; } if (n === r.priority) return; await this.run(() => api.patch(`/api/rules/${r.id}`, { priority: n })); toast(`Priority ${n}: ${this.summary(r)}`.slice(0, 90)); await this.load(); }} /></td><td>${this.summary(r)}<div class="muted small">${r.notes ? String(r.notes).slice(0, 60) : ''}</div></td><td>${this.act(r)}</td>
          <td><select @change=${async (e: any) => { await api.patch(`/api/rules/${r.id}`, { mode: e.target.value }); this.load(); }}>${['auto', 'suggest', 'ask'].map((m) => html`<option ?selected=${m === r.mode}>${m}</option>`)}</select></td>
          <td class="num">${r.hit_count}</td><td><button class=${r.enabled ? 'rule-off' : 'rule-on'} @click=${async () => { await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled }); if (r.enabled && !this.showOff) toast('Rule disabled and hidden. Tick "Show disabled" to see it again.'); await this.load(); }}>${r.enabled ? 'Disable' : 'Enable'}</button></td></tr>`)}</tbody></table></div>
      ${this.pager(this.rpage, list.length, (n) => (this.rpage = n))}`;
  }
  merchantsTab() {
    const m = this.merch;
    return html`<div class="card muted small" style="margin:0">A <b>merchant</b> is a shop's cleaned-up name, taken from the messy text on your bank statement ("SQ *BLUE BOTTLE #12 SEATTLE WA" becomes "BLUE BOTTLE"). HearthKeeper counts what you choose for each one, and the category you pick most often is what it suggests next time. It <b>only ever suggests</b>: a one-off exception costs nothing, and your rules always come first. If you want a merchant to always land in one category, turn it into a rule with <b>Make a rule…</b>.</div>
      <div class="row"><input class="grow" type="search" placeholder="Search merchants" .value=${this.mq} @input=${(e: any) => { this.mq = e.target.value; this.mpage = 0; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(() => this.loadMerchants()), 250); }} />
        <select aria-label="Which merchants" @change=${(e: any) => { this.onlyNew = e.target.value === 'nohistory'; this.mpage = 0; this.run(() => this.loadMerchants()); }}><option value="nohistory" ?selected=${this.onlyNew}>Never categorized by you yet (${m.withoutHistory.toLocaleString()}), most-used first</option><option value="all" ?selected=${!this.onlyNew}>All merchants (most-used first)</option></select></div>
      <div class="card flush mlist"><div class="mrow mhead"><span data-tip="The cleaned-up name of the shop." tabindex="0">Merchant</span><span class="num" data-tip="How many of your transactions are from it." tabindex="0">Txns</span><span data-tip="What you have chosen for it, most often first. The top one is what it suggests." tabindex="0">History</span><span></span></div>
      ${repeat(m.rows, (x: any) => x.id, (x: any) => html`<div class="mrow"><div class="mname"><b>${x.name}</b><span class="muted small mtx">${x.txns} txn${x.txns === 1 ? '' : 's'}</span></div><span class="num mtxn">${x.txns}</span>
        <div class="mcat mhist">${x.history.length ? x.history.map((h: any, i: number) => html`<span class="chip ${i === 0 ? 'top' : ''}" data-cat=${h.name}>${h.name} <b>×${h.n}</b></span>`) : html`<span class="muted small">Nothing chosen yet</span>`}</div>
        <div class="mact"><button class="mk-rule" @click=${() => this.makeRule(x)}>Make a rule…</button><button @click=${() => this.fix(x)}>Fix name…</button></div></div>`)}</div>
      ${this.pager(this.mpage, m.total, (n) => { this.mpage = n; this.run(() => this.loadMerchants()); })}`;
  }
  /** Promote a merchant into a full rule of yours: pick the category (its usual one is pre-filled), see what it would have done, save. */
  async makeRule(x: any) {
    await this.ruleDialog({ title: `Make a rule for ${x.name}`, intro: 'Transactions that match go to the category below. Start from the merchant and narrow it down (for example only when the description also contains a word or the amount is in a range), or add alternatives. A rule of yours always comes before the merchant\'s usual category.', cat: x.history[0]?.categoryId ?? null, clauses: [{ alts: [{ field: 'merchant', value: x.name }] }], notes: `from merchant ${x.name}`, saved: (n) => `Rule saved: ${x.name} → ${n}` });
  }
  /** A rule from scratch: no transaction or merchant to start from. */
  async newRule() {
    await this.ruleDialog({ title: 'New rule', intro: 'Say what to match, and which category it should go to. Conditions are joined with AND; use "or another way to match" for alternatives. A rule of yours always comes before a merchant\'s usual category.', cat: null, clauses: [{ alts: [{ field: 'descriptor', value: '' }] }], notes: 'created on the Rules page', saved: (n) => `Rule saved → ${n}` });
  }
  async ruleDialog(o: { title: string; intro: string; cat: number | null; clauses: RuleClause[]; notes: string; saved: (categoryName: string) => string }) {
    const d = { cat: o.cat, mode: 'suggest' as 'suggest' | 'auto', priority: 100, clauses: o.clauses };
    let bt: any = null, seq = 0, timer: any;
    const spec = await showDialog<any>((close) => {
      const box = document.createElement('div');
      const draw = () => import('lit').then(({ render }) => render(tpl(), box));
      const test = () => { bt = null; clearTimeout(timer); const mine = ++seq; if (clausesValid(d.clauses)) timer = setTimeout(() => api.post('/api/rules/backtest', { match: matchFromClauses(d.clauses) }).then((r) => { if (mine === seq) { bt = r; void draw(); } }, () => undefined), 250); void draw(); }; // the preview is optional
      const ok = () => clausesValid(d.clauses) && !!d.cat && Number.isInteger(d.priority) && d.priority >= 1 && d.priority <= 9999;
      const tpl = () => html`<h3 class="title">${o.title}</h3>
        <p class="muted small">${o.intro}</p>
        ${ruleBuilder(d.clauses, test)}
        <div class="row"><span class="muted small">Category</span>${catSelect(this.cats, d.cat, (id) => { d.cat = id; void draw(); }, { placeholder: 'Category' })}</div>
        <div class="row" style="margin-top:8px"><label class="muted small">When it matches <select class="rf-mode" @change=${(e: any) => { d.mode = e.target.value; void draw(); }}><option value="suggest" ?selected=${d.mode === 'suggest'}>suggest it</option><option value="auto" ?selected=${d.mode === 'auto'}>file it automatically</option></select></label>
          <label class="muted small" data-tip="Lower numbers are checked first. If two rules match, the lower number wins." tabindex="0">Priority <input class="rf-pri" type="number" min="1" max="9999" step="1" style="width:5rem" .value=${String(d.priority)} @input=${(e: any) => { d.priority = Number(e.target.value); void draw(); }} /></label></div>
        <p class="muted small rf-bt" style="margin:8px 0 0">${bt ? html`It would have matched <b>${bt.matched}</b> past transaction${bt.matched === 1 ? '' : 's'}${bt.matched ? `: ${Object.entries(bt.byCategory).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.` : clausesValid(d.clauses) ? 'Checking your history…' : 'Fill in every condition.'}</p>
        <div class="actions"><button class="cancel" @click=${() => close(undefined)}>Cancel</button><button class="primary rf-save" ?disabled=${!ok()} @click=${() => close({ ...d })}>Save rule</button></div>`;
      test();
      return html`${box}`;
    }, { dismiss: false });
    if (!spec) return;
    const name = this.cats.find((c) => c.id === spec.cat)!.name;
    await this.run(async () => { await api.post('/api/rules', { match: matchFromClauses(spec.clauses), action: { type: 'categorize', category: name }, mode: spec.mode, priority: spec.priority, notes: o.notes }); });
    toast(o.saved(name)); await this.load();
  }
  /** One entry point for the two maintenance actions, each explained. */
  async fix(x: any) {
    const choice = await showDialog<'rename' | 'merge' | undefined>((close) => html`<h3 class="title">${x.name}</h3>
      <p class="muted small"><b>Rename</b> changes how the name is shown everywhere. Use it when the cleaned-up name is ugly or wrong.</p>
      <p class="muted small"><b>Merge</b> is for when two entries are really the same shop (for example "AMZN MKTP" and "AMAZON"). All of its transactions move to the one you keep, so they share a usual category and statistics. You cannot undo it.</p>
      <div class="actions"><button @click=${() => close(undefined)}>Cancel</button><button @click=${() => close('rename')}>Rename…</button><button @click=${() => close('merge')}>Merge into another…</button></div>`);
    if (choice === 'rename') await this.rename(x); else if (choice === 'merge') await this.merge(x);
  }
  async rename(x: any) { const n = await promptBox({ title: `Rename ${x.name}`, label: 'New name', value: x.name, confirm: 'Rename' }); if (n) { await this.run(() => api.patch(`/api/merchants/${x.id}`, { name: n })); await this.loadMerchants(); } }
  async merge(x: any) {
    let q = '', found: any[] = [], timer: any; let into: any = null;
    const target = await showDialog<any>((close) => {
      const box = document.createElement('div');
      const draw = () => import('lit').then(({ render }) => render(html`${found.map((r) => html`<button class="option" @click=${() => close(r)}><span class="name">${r.name}</span><span class="meta">${r.txns} txns</span></button>`)}${q && !found.length ? html`<p class="muted">No other merchant matches.</p>` : nothing}`, box));
      box.className = 'option-list'; box.style.marginTop = '10px';
      return html`<h3 class="title">Merge “${x.name}” into…</h3><p class="muted small">Its transactions move to the merchant you choose, and its name becomes an alias of it.</p>
        <input style="width:100%" placeholder="Search for the merchant to keep" @input=${(e: any) => { q = e.target.value; clearTimeout(timer); timer = setTimeout(async () => { found = q ? (await api.get(`/api/merchants?limit=8&q=${encodeURIComponent(q)}`)).rows.filter((r: any) => r.id !== x.id) : []; draw(); }, 200); }} />${box}
        <div class="actions"><button @click=${() => close(undefined)}>Cancel</button></div>`;
    });
    if (target && await confirmBox({ title: 'Merge merchants?', body: html`Merge <b>${x.name}</b> into <b>${target.name}</b>? This cannot be undone.`, confirm: 'Merge', danger: true })) {
      await this.run(() => api.post(`/api/merchants/${x.id}/merge`, { intoId: target.id })); await this.loadMerchants();
    }
  }
}
