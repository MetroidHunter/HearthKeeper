import { html, nothing, render, type TemplateResult } from 'lit';
import { api, money, fmtDate, parseMoney } from './api.js';
import { amt, pace } from './shared.js';
import { showDialog, alertBox, promptBox, toast, catSelect, pendingBadge, withBusy, type PickCat } from './ui.js';

export interface BudgetRow { id: number; name: string; group: string | null; kind: string; targetCents: number; currentCents: number | null; spent: [number, number]; gained: [number, number] }
type WireCond = { field: string; op: string; value: string };
export interface RuleSpec { match: { all_of: (WireCond | { any_of: WireCond[] })[] }; mode: 'suggest' | 'auto'; priority: number }

/** The rule builder: clauses joined by AND, each clause one condition or several alternatives joined by OR. */
export interface RuleClause { alts: { field: string; value: string }[] }
const RULE_FIELDS: [string, string][] = [['merchant', 'Merchant is'], ['descriptor', 'Description contains'], ['note', 'Note contains'], ['account', 'Account is']];
const exactField = (f: string) => f === 'merchant' || f === 'account';
export const clausesValid = (cs: RuleClause[]) => cs.length > 0 && cs.every((c) => c.alts.length > 0 && c.alts.every((a) => a.value.trim()));
export const matchFromClauses = (cs: RuleClause[]): RuleSpec['match'] => ({ all_of: cs.map((c) => { const conds = c.alts.map((a) => ({ field: a.field, op: exactField(a.field) ? 'eq' : 'contains', value: a.value.trim() })); return conds.length === 1 ? conds[0] : { any_of: conds }; }) });
/** Edits `cs` in place and calls `changed` after every edit (the caller redraws and refreshes its backtest). */
export function ruleBuilder(cs: RuleClause[], changed: () => void, fields: [string, string][] = RULE_FIELDS): TemplateResult {
  const total = () => cs.reduce((a, c) => a + c.alts.length, 0);
  return html`<div class="rulebuilder">${cs.map((c, i) => html`<div class="rb-clause" data-clause=${i}>${i > 0 ? html`<div class="rb-join and">AND</div>` : nothing}
    ${c.alts.map((a, j) => html`${j > 0 ? html`<div class="rb-join or">OR</div>` : nothing}<div class="row rb-alt">
      <select class="rf-field" aria-label="Match on" @change=${(e: any) => { a.field = e.target.value; changed(); }}>${fields.map(([f, l]) => html`<option value=${f} ?selected=${a.field === f}>${l}</option>`)}</select>
      <input class="grow rf-value" aria-label="Value to match" .value=${a.value} @input=${(e: any) => { a.value = e.target.value; changed(); }} />
      ${total() > 1 ? html`<button class="icon rb-del" aria-label="Remove this condition" @click=${() => { c.alts.splice(j, 1); if (!c.alts.length) cs.splice(i, 1); changed(); }}>✕</button>` : nothing}</div>`)}
    <button class="link rb-or" @click=${() => { c.alts.push({ field: c.alts[0]?.field ?? 'descriptor', value: '' }); changed(); }}>＋ or another way to match</button></div>`)}
    <button class="rb-and-add" @click=${() => { cs.push({ alts: [{ field: 'descriptor', value: '' }] }); changed(); }}>＋ and another condition</button></div>`;
}
export interface Suggestion { id: number; name: string; why: string }
export interface TxnLike { kind?: string; id: number; occurred_on: string; amount_cents: number; effective_cents?: number; descriptor_raw: string; descriptor_clean?: string | null; account: string; status?: string; merchant?: string | null; note?: string | null; note_state?: string; flag_reason?: string | null; why?: string; suggestions?: Suggestion[] }

export interface Env {
  cats: PickCat[]; rows: BudgetRow[];
  /** Apply the decision (and the rule made in the same step, if any). Return a promise; the page reloads itself afterwards. */
  categorize: (txnIds: number[], categoryId: number, rule?: RuleSpec) => Promise<void>;
  ignore?: (t: TxnLike) => Promise<void>;
}

export const NOT_A_BUDGET_ITEM = 'Use this when the transaction is not household spending or income: a transfer between your own accounts, a reimbursed or duplicate charge, a payment that belongs to someone else. It is hidden from budgets, charts and the inbox, but kept in your history. Restore it any time from Transactions with Show hidden.';
const whyLabel: Record<string, string> = { rule: 'your rule', 'merchant history': 'what you usually choose for this merchant', similar: 'a similar merchant', 'frequently used': 'often used' };
const whyShort: Record<string, string> = { rule: 'Rule', 'merchant history': 'Merchant' };

/** The whole line as the bank sent it, plus everything we know, so a decision never has to be guessed. */
export const fullLine = (t: TxnLike) => html`<div class="txn-line" title="Exactly as received">${fmtDate(t.occurred_on)} · ${t.account} · ${t.descriptor_raw}${t.note ? html` · note: ${t.note}` : nothing}</div>`;

/** Log-style context: what came just before and after this on the same account. */
export async function showContext(t: TxnLike) {
  const c = await api.get(`/api/transactions/${t.id}/context?before=8&after=8`);
  await showDialog((close) => html`<h3 class="title">Around this transaction</h3><p class="muted small">${t.account}, in date order. The highlighted line is the one you are deciding on.</p>
    <div class="card flush">${c.rows.map((r: any) => html`<div class="ctx-row ${r.isTarget ? 'target' : ''}"><span class="muted">${fmtDate(r.occurred_on)}</span>
      <span>${r.descriptor_raw}${r.status === 'provisional' ? pendingBadge() : nothing}<div class="muted small">${r.categories || '(no category)'}${r.note ? ` · ${r.note}` : ''}</div></span>${amt(r.amount_cents)}</div>`)}</div>
    <div class="actions"><button class="primary" @click=${() => close()}>Close</button></div>`, { wide: true });
}

/**
 * Divide one transaction between categories (a Costco run that is half groceries, half household). Amounts are typed as positive money;
 * the sign of the original is applied on save. Save stays disabled until every part has a category and the parts add up exactly.
 */
export function splitDialog(env: Env, t: TxnLike): Promise<{ categoryId: number; amountCents: number }[] | undefined> {
  const sign = (t.effective_cents ?? t.amount_cents) < 0 ? -1 : 1; const total = Math.abs(t.effective_cents ?? t.amount_cents);
  const fmt = (c: number) => (c / 100).toFixed(2);
  const lines: { categoryId: number | null; cents: number; text: string }[] = [{ categoryId: null, cents: total, text: fmt(total) }, { categoryId: null, cents: 0, text: '0.00' }];
  return showDialog<{ categoryId: number; amountCents: number }[]>((close) => {
    const box = document.createElement('div'); box.className = 'splitbox';
    const draw = () => render(tpl(), box);
    const sum = () => lines.reduce((a, l) => a + l.cents, 0);
    const valid = () => lines.length >= 2 && sum() === total && lines.every((l) => l.categoryId && l.cents > 0);
    const tpl = () => html`${lines.map((l, i) => html`<div class="splitrow" data-i=${i}><span class="splitcat">${catSelect(env.cats, l.categoryId, (id) => { l.categoryId = id; draw(); }, { placeholder: 'Category' })}</span>
        <input class="splitamt" inputmode="decimal" aria-label="Amount" .value=${l.text} @input=${(e: any) => { l.text = e.target.value; const v = parseMoney(l.text || '0'); l.cents = Number.isFinite(v) ? Math.max(0, v) : 0; draw(); }} />
        ${lines.length > 2 ? html`<button class="icon splitdel" aria-label="Remove this part" @click=${() => { lines.splice(i, 1); draw(); }}>✕</button>` : nothing}</div>`)}
      <div class="row" style="margin-top:8px"><button class="splitadd" @click=${() => { const rest = Math.max(0, total - sum()); lines.push({ categoryId: null, cents: rest, text: fmt(rest) }); draw(); }}>＋ Add a part</button>
        <button class="spliteven" @click=${() => { const n = lines.length, each = Math.floor(total / n); lines.forEach((l, i) => { l.cents = i === n - 1 ? total - each * (n - 1) : each; l.text = fmt(l.cents); }); draw(); }}>Split evenly</button>
        <span class="right splitleft ${sum() === total ? 'pos' : 'neg'}" aria-live="polite">${sum() === total ? (lines.some((l) => !l.categoryId) ? 'Amounts add up. Choose a category for each part.' : lines.some((l) => l.cents <= 0) ? 'Every part needs an amount.' : 'Adds up') : sum() < total ? `${money(total - sum())} left to place` : `${money(sum() - total)} too much`}</span></div>
      <div class="actions"><button class="cancel" @click=${() => close(undefined)}>Cancel</button><button class="primary splitsave" ?disabled=${!valid()} @click=${() => close(lines.map((l) => ({ categoryId: l.categoryId!, amountCents: sign * l.cents })))}>Save split</button></div>`;
    draw();
    return html`<h3 class="title">Split ${t.descriptor_clean || t.descriptor_raw}</h3><p class="muted small">${fmtDate(t.occurred_on)} · total ${money(total)} ${sign < 0 ? 'out' : 'in'}. Divide it between categories; the parts must add up to the total.</p>${box}`;
  }, { dismiss: false });
}

/**
 * Before a category sticks, show what it does to that category's budget. Resolves {ok, rule}. The same dialog is where a rule is made:
 * tick "Make a rule" and say what it should match, how it applies (suggest or auto) and its priority; the backtest shows what it would have done.
 * Merchants are never learned silently any more: what you choose is counted (that is the merchant's suggestion), and rules are always your own decision.
 */
export async function confirmCategorize(env: Env, txns: TxnLike[], categoryId: number, opts: { groupName?: string; count?: number; seed?: { merchant?: string | null; descriptor: string } } = {}): Promise<{ ok: boolean; rule?: RuleSpec }> {
  const cat = env.cats.find((c) => c.id === categoryId);
  const row = env.rows.find((r) => r.id === categoryId);
  const delta = txns.reduce((a, t) => a + (t.effective_cents ?? t.amount_cents), 0); // a Greenlight reclass is booked at its real spend, not its zero total
  const before = row?.currentCents ?? null, after = before === null ? null : before + delta;
  const spendDelta = -delta; // negative transactions are spending
  const seed = opts.seed ?? { merchant: txns[0]?.merchant, descriptor: txns[0]?.descriptor_clean || txns[0]?.descriptor_raw || '' };
  const draft = { on: false, clauses: [{ alts: [seed.merchant ? { field: 'merchant', value: seed.merchant } : { field: 'descriptor', value: seed.descriptor }] }] as RuleClause[], mode: 'suggest' as 'suggest' | 'auto', priority: 100 };
  let bt: { matched: number; byCategory: Record<string, number> } | null = null, btTimer: any, btSeq = 0;
  const matchOf = () => matchFromClauses(draft.clauses);
  const ruleOk = () => !draft.on || (clausesValid(draft.clauses) && Number.isInteger(draft.priority) && draft.priority >= 1 && draft.priority <= 9999);
  return new Promise<{ ok: boolean; rule?: RuleSpec }>((resolve) => {
    void showDialog<boolean>((close) => {
      const box = document.createElement('div');
      const draw = () => render(tpl(), box);
      const test = () => { bt = null; clearTimeout(btTimer); const mine = ++btSeq; if (!draft.on || !clausesValid(draft.clauses)) return draw(); btTimer = setTimeout(async () => { try { const r = await api.post('/api/rules/backtest', { match: matchOf() }); if (mine === btSeq) { bt = r; draw(); } } catch { /* the preview is optional */ } }, 250); draw(); };
      const impact = html`<div class="card"><div class="impact">
        <b>${cat?.name}</b><span class="muted small">Balance now</span><span class="muted small">This change</span><span class="muted small">Balance after</span>
        <span class="muted small">${row ? `Monthly target ${money(row.targetCents)}` : ''}</span><span class="mono">${before === null ? 'N/A' : money(before)}</span><span class="mono ${delta < 0 ? 'neg' : 'pos'}">${money(delta, { sign: true })}</span><b class="mono ${after !== null && after < 0 ? 'neg' : ''}">${after === null ? 'N/A' : money(after)}</b>
        ${row && row.kind === 'expense' ? html`<span class="muted small">Spent this month</span><span class="mono">${money(row.spent[0])}</span><span class="mono">${money(spendDelta, { sign: true })}</span><span class="mono">${money(row.spent[0] + spendDelta)}</span>` : nothing}
      </div>${row && row.targetCents > 0 && row.kind === 'expense' ? html`<div class="bar ${row.spent[0] + spendDelta > row.targetCents ? 'over' : ''}" style="margin-top:10px"><i style="width:${pace(row.spent[0] + spendDelta, row.targetCents)}%"></i></div>` : nothing}
      ${after !== null && after < 0 && (before ?? 0) >= 0 ? html`<p class="neg" style="margin:10px 0 0">This pushes ${cat?.name} ${money(-after)} into overspending.</p>` : nothing}</div>`;
      const tpl = () => html`<h3 class="title">Categorize as ${cat?.name ?? 'this category'}?</h3>
        <p class="muted small">${txns.length === 1 && !opts.count ? `${txns[0].descriptor_clean || txns[0].descriptor_raw}, ${fmtDate(txns[0].occurred_on)}` : `${opts.count ?? txns.length} transactions${opts.groupName ? ` from ${opts.groupName}` : ''}`} · total ${money(delta)}</p>
        ${impact}
        <label class="row makerule" style="margin-top:12px"><input type="checkbox" id="make-rule" .checked=${draft.on} @change=${(e: any) => { draft.on = e.target.checked; test(); }} /> <span>Make a rule so this happens automatically next time</span></label>
        ${draft.on ? html`<div class="card ruleform" style="margin-top:8px">${ruleBuilder(draft.clauses, test, seed.merchant ? undefined : RULE_FIELDS.filter(([f]) => f !== 'merchant'))}
          <div class="row" style="margin-top:8px"><label class="muted small">When it matches <select class="rf-mode" @change=${(e: any) => { draft.mode = e.target.value; draw(); }}><option value="suggest" ?selected=${draft.mode === 'suggest'}>suggest ${cat?.name ?? ''}</option><option value="auto" ?selected=${draft.mode === 'auto'}>file it automatically</option></select></label>
            <label class="muted small" data-tip="Lower numbers are checked first. If two rules match, the lower number wins." tabindex="0">Priority <input class="rf-pri" type="number" min="1" max="9999" step="1" style="width:5rem" .value=${String(draft.priority)} @input=${(e: any) => { draft.priority = Number(e.target.value); draw(); }} /></label></div>
          <p class="muted small rf-bt" style="margin:8px 0 0" aria-live="polite">${bt ? html`This rule would have matched <b>${bt.matched}</b> past transaction${bt.matched === 1 ? '' : 's'}${bt.matched ? `: ${Object.entries(bt.byCategory).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''}.` : clausesValid(draft.clauses) ? 'Checking your history…' : 'Fill in every condition.'}
            Rules you make always come before the merchant's usual category, which only ever suggests.</p></div>` : nothing}
        <div class="actions"><button class="cancel" @click=${() => close(false)}>Cancel</button><button class="primary confirm" autofocus ?disabled=${!ruleOk()} @click=${() => close(true)}>${draft.on ? 'Yes, categorize and make the rule' : 'Yes, categorize'}</button></div>`;
      draw();
      return html`${box}`;
    }, { dismiss: false }).then((ok) => resolve({ ok: ok === true, rule: ok === true && draft.on && ruleOk() ? { match: matchOf(), mode: draft.mode, priority: draft.priority } : undefined }));
  });
}

/** Column labels for a list of rows (desktop only; the cells carry their own placeholders on a phone). Same order as the Transactions table. */
export const txnHead = () => html`<div class="trow thead" aria-hidden="true"><div class="tcells"><span>Date</span><span>Description</span><span class="tamt">Amount</span><span>Category</span><span>Note</span></div></div>`;

/**
 * One transaction that needs a person, as a two-line table row in the same column order as the Transactions table:
 * Date, Description, Amount, Category, Note. A missing category is a dropdown right in the Category cell (with the best guess one tap away);
 * a missing note is an input with icon buttons for "find the matching Amazon/Venmo/PayPal note" and "no note needed". The thin second line
 * holds anything else that is open (a flag, a charge that never posted) and opens the raw details: the bank's line, the account, why it
 * needs you, nearby transactions and "not a budget item". The row stays, showing what is still open, until nothing is.
 */
export function txnRow(env: Env, t: TxnLike & { reason?: string; reasons?: { reason: string; why: string }[]; categories?: string | null }, hooks: { reload: () => unknown } = { reload: () => undefined }): TemplateResult {
  const reasons = t.reasons ?? (t.reason ? [{ reason: t.reason, why: t.why ?? '' }] : []);
  const has = (r: string) => reasons.find((x) => x.reason === r);
  const picks = t.suggestions ?? [];
  // Every save blocks input behind a "working" modal until the change AND the refreshed list are in, so nothing can be clicked half-way through.
  const attempt = async (what: () => Promise<unknown>, done: string) => {
    try { await withBusy('Saving…', async () => { await what(); await hooks.reload(); }); toast(done); }
    catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); await hooks.reload(); }
  };
  const decide = async (categoryId: number) => {
    const { ok, rule } = await confirmCategorize(env, [t], categoryId);
    if (!ok) return;
    await attempt(() => env.categorize([t.id], categoryId, rule), `Categorized as ${env.cats.find((c) => c.id === categoryId)?.name ?? 'the category'}${rule ? ' and rule saved' : ''}`);
  };
  const patch = (body: unknown) => api.patch(`/api/transactions/${t.id}`, body);
  const saveNote = (v: string) => { const n = v.trim(); if (n) void attempt(() => patch({ note: n }), 'Note saved'); };
  const pickNote = async () => {
    const c: any[] = await api.get(`/api/transactions/${t.id}/note-candidates`);
    const chosen = await showDialog<any>((close) => html`<h3 class="title">Which note is this?</h3>${c.length ? html`<div class="option-list">${c.slice(0, 8).map((n) => html`<button class="option" @click=${() => close(n)}><span class="name">${n.note || '(no note)'}</span><span class="muted small">${n.source} · ${fmtDate(n.occurred_on)} · ${money(n.amount_cents)}</span></button>`)}</div>` : html`<p class="muted">No matching Amazon, Venmo or PayPal note yet. Type one in the box instead.</p>`}<div class="actions"><button @click=${() => close(undefined)}>Cancel</button></div>`);
    if (chosen) await attempt(() => api.post(`/api/transactions/${t.id}/note`, { noteId: chosen.id }), 'Note attached');
  };
  // Two answers can be on offer at once: the one from a rule of yours and the one from what you usually pick for this merchant.
  const ruleSug = picks.find((p) => p.why === 'rule'), merchSug = picks.find((p) => p.why === 'merchant history' && p.id !== ruleSug?.id);
  const quick = [ruleSug, merchSug].filter((p): p is Suggestion => !!p); if (!quick.length && picks[0]) quick.push(picks[0]);
  const catMissing = !!has('needs_category'), noteMissing = !!has('needs_note');
  const shown = t.effective_cents ?? t.amount_cents;
  const catCell = catMissing
    ? html`<span class="tcat-in">${catSelect(env.cats, null, (id) => { if (id) void decide(id); }, { placeholder: 'Category', reset: true })}${quick.map((q) => html`<button class="quick" data-why=${q.why} title=${`${whyLabel[q.why] ?? q.why}: use ${q.name}`} @click=${() => decide(q.id)}>${whyShort[q.why] ? html`<span class="qwhy">${whyShort[q.why]}</span> ` : nothing}${q.name}</button>`)}</span>`
    : html`<span class="tval ${t.categories ? '' : 'empty'}" title=${t.categories ?? ''}>${t.categories ?? html`<span class="muted">–</span>`}</span>`;
  const noteCell = noteMissing
    ? html`<span class="tnote-in"><input class="note-input" placeholder="Note" aria-label="Note" @change=${(e: any) => saveNote(e.target.value)} />
        <button class="icon note-pick" title="Find the matching Amazon, Venmo or PayPal note" aria-label="Matching notes" @click=${pickNote}>🔗</button>
        <button class="icon note-none" title="No note needed" aria-label="No note needed" @click=${() => attempt(() => patch({ noteState: 'not_needed' }), 'Marked: no note needed')}>⊘</button></span>`
    : html`<span class="tval ${t.note ? '' : 'empty'}" title=${t.note ?? ''}>${t.note ?? html`<span class="muted">–</span>`}</span>`;
  const toggle = (e: Event) => { const row = (e.currentTarget as HTMLElement).closest('.trow')!; const open = row.classList.toggle('open'); (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open)); };
  const why = reasons.map((r) => r.why).filter(Boolean);
  return html`<div class="trow txn" data-id=${t.id} data-cat=${catMissing ? 'missing' : t.categories ? 'ok' : 'none'} data-note=${noteMissing ? 'missing' : t.note ? 'ok' : 'none'}>
    <div class="tcells">
      <span class="tdate">${fmtDate(t.occurred_on)}</span>
      <span class="tdesc" title=${t.descriptor_raw}>${t.descriptor_clean || t.descriptor_raw}${t.status === 'provisional' ? pendingBadge() : nothing}</span>
      <span class="tamt">${amt(shown)}</span>
      <span class="tcat">${catCell}</span>
      <span class="tnote">${noteCell}</span>
    </div>
    <div class="tsub">
      <button class="texpand" aria-expanded="false" @click=${toggle}><span class="caret" aria-hidden="true">▸</span> Details</button>
      ${has('flagged') ? html`<span class="chip bad" data-flag>⚑ ${t.flag_reason ?? 'Flagged for follow-up'}</span><button class="unflag" @click=${() => attempt(() => patch({ flagged: 0 }), 'Flag cleared')}>Mark reviewed</button>` : nothing}
      ${has('stale') ? html`<span class="chip warn" data-stale>Never posted</span><button class="hide-stale" @click=${() => attempt(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'pending charge never posted' }), 'Hidden')}>Hide it</button>` : nothing}
    </div>
    <div class="tmore">
      ${why.map((w) => html`<div class="muted small why-text"><span aria-hidden="true">ⓘ</span> ${w}</div>`)}
      <div class="muted small">${t.account}${t.status === 'provisional' ? ' · pending, not posted yet' : ''}</div>
      ${fullLine(t)}
      <div class="row">${!catMissing ? html`<span class="muted small">Change category:</span>${catSelect(env.cats, null, (id) => { if (id) void decide(id); }, { placeholder: 'Search all categories…', reset: true })}` : nothing}
        ${!noteMissing ? html`<span class="muted small">${t.note ? 'Edit note:' : 'Add a note:'}</span><input class="note-edit" placeholder="Note" .value=${t.note ?? ''} @change=${(e: any) => saveNote(e.target.value)} />` : nothing}</div>
      <div class="row"><button class="split-btn" ?hidden=${t.kind === 'greenlight_reclass'} @click=${async () => { const s = await splitDialog(env, t); if (s) await attempt(() => api.post(`/api/transactions/${t.id}/categorize`, { splits: s }), 'Split saved'); }}>Split…</button><button @click=${() => showContext(t)}>Show nearby transactions</button>${env.ignore ? html`<button data-tip=${NOT_A_BUDGET_ITEM} @click=${() => attempt(() => env.ignore!(t), 'Marked: not a budget item')}>Not a budget item</button>` : nothing}</div>
    </div></div>`;
}
