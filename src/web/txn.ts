import { html, nothing, type TemplateResult } from 'lit';
import { api, money, fmtDate } from './api.js';
import { amt, pace } from './shared.js';
import { showDialog, alertBox, promptBox, toast, catSelect, type PickCat } from './ui.js';

export interface BudgetRow { id: number; name: string; group: string | null; kind: string; targetCents: number; currentCents: number | null; spent: [number, number]; gained: [number, number] }
export interface Suggestion { id: number; name: string; why: string }
export interface TxnLike { id: number; occurred_on: string; amount_cents: number; effective_cents?: number; descriptor_raw: string; descriptor_clean?: string | null; account: string; status?: string; note?: string | null; note_state?: string; flag_reason?: string | null; why?: string; suggestions?: Suggestion[] }

export interface Env {
  cats: PickCat[]; rows: BudgetRow[];
  /** Apply the decision. Return a promise; the page reloads itself afterwards. */
  categorize: (txnIds: number[], categoryId: number, makeRule: boolean) => Promise<void>;
  ignore?: (t: TxnLike) => Promise<void>;
}

export const NOT_A_BUDGET_ITEM = 'Use this when the transaction is not household spending or income: a transfer between your own accounts, a reimbursed or duplicate charge, a payment that belongs to someone else. It is hidden from budgets, charts and the inbox, but kept in your history. Restore it any time from Transactions with Show hidden.';
const whyLabel: Record<string, string> = { rule: 'rule matches', merchant: 'you used it for this merchant', similar: 'similar merchant', frequent: 'often used' };

/** The whole line as the bank sent it, plus everything we know, so a decision never has to be guessed. */
export const fullLine = (t: TxnLike) => html`<div class="txn-line" title="Exactly as received">${fmtDate(t.occurred_on)} · ${t.account} · ${t.descriptor_raw}${t.note ? html` · note: ${t.note}` : nothing}</div>`;

/** Log-style context: what came just before and after this on the same account. */
export async function showContext(t: TxnLike) {
  const c = await api.get(`/api/transactions/${t.id}/context?before=8&after=8`);
  await showDialog((close) => html`<h3 class="title">Around this transaction</h3><p class="muted small">${t.account}, in date order. The highlighted line is the one you are deciding on.</p>
    <div class="card flush">${c.rows.map((r: any) => html`<div class="ctx-row ${r.isTarget ? 'target' : ''}"><span class="muted">${fmtDate(r.occurred_on)}</span>
      <span>${r.descriptor_raw}${r.status === 'provisional' ? html` <span class="badge warn">pending</span>` : nothing}<div class="muted small">${r.categories || '(no category)'}${r.note ? ` · ${r.note}` : ''}</div></span>${amt(r.amount_cents)}</div>`)}</div>
    <div class="actions"><button class="primary" @click=${() => close()}>Close</button></div>`, { wide: true });
}

/** Before a category sticks, show what it does to that category's budget. Resolves {ok, remember}. */
export async function confirmCategorize(env: Env, txns: TxnLike[], categoryId: number, opts: { suggestedBy?: string; defaultRemember?: boolean; groupName?: string; count?: number } = {}): Promise<{ ok: boolean; remember: boolean }> {
  const cat = env.cats.find((c) => c.id === categoryId);
  const row = env.rows.find((r) => r.id === categoryId);
  const delta = txns.reduce((a, t) => a + (t.effective_cents ?? t.amount_cents), 0); // a Greenlight reclass is booked at its real spend, not its zero total
  const before = row?.currentCents ?? null, after = before === null ? null : before + delta;
  const spendDelta = -delta; // negative transactions are spending
  let remember = opts.defaultRemember ?? false;
  const ok = await showDialog<boolean>((close) => html`<h3 class="title">Categorize as ${cat?.name ?? 'this category'}?</h3>
    <p class="muted small">${txns.length === 1 && !opts.count ? `${txns[0].descriptor_clean || txns[0].descriptor_raw}, ${fmtDate(txns[0].occurred_on)}` : `${opts.count ?? txns.length} transactions${opts.groupName ? ` from ${opts.groupName}` : ''}`} · total ${money(delta)}</p>
    <div class="card"><div class="impact">
      <b>${cat?.name}</b><span class="muted small">Balance now</span><span class="muted small">This change</span><span class="muted small">Balance after</span>
      <span class="muted small">${row ? `Monthly target ${money(row.targetCents)}` : ''}</span><span class="mono">${before === null ? 'N/A' : money(before)}</span><span class="mono ${delta < 0 ? 'neg' : 'pos'}">${money(delta, { sign: true })}</span><b class="mono ${after !== null && after < 0 ? 'neg' : ''}">${after === null ? 'N/A' : money(after)}</b>
      ${row && row.kind === 'expense' ? html`<span class="muted small">Spent this month</span><span class="mono">${money(row.spent[0])}</span><span class="mono">${money(spendDelta, { sign: true })}</span><span class="mono">${money(row.spent[0] + spendDelta)}</span>` : nothing}
    </div>${row && row.targetCents > 0 && row.kind === 'expense' ? html`<div class="bar ${row.spent[0] + spendDelta > row.targetCents ? 'over' : ''}" style="margin-top:10px"><i style="width:${pace(row.spent[0] + spendDelta, row.targetCents)}%"></i></div>` : nothing}
    ${after !== null && after < 0 && (before ?? 0) >= 0 ? html`<p class="neg" style="margin:10px 0 0">This pushes ${cat?.name} ${money(-after)} into overspending.</p>` : nothing}</div>
    <label class="row" style="margin-top:12px"><input type="checkbox" id="remember" .checked=${remember} @change=${(e: any) => (remember = e.target.checked)} /> <span>Remember this: suggest ${cat?.name} next time${opts.groupName ? ` for ${opts.groupName}` : ' for this merchant'}</span></label>
    <div class="actions"><button class="cancel" @click=${() => close(false)}>Cancel</button><button class="primary confirm" autofocus @click=${() => close(true)}>Yes, categorize</button></div>`, { dismiss: false });
  return { ok: ok === true, remember };
}

/**
 * One transaction that needs a person, laid out as a checklist: Category and Note (plus Flag / Never-posted when they apply), each
 * with a big "?" while it is missing or unknown and a check once it is settled. Everything else (account, the bank's full line,
 * nearby transactions, "not a budget item") sits behind Details. The card stays, showing what is still open, until nothing is.
 */
export function txnCard(env: Env, t: TxnLike & { reason?: string; reasons?: { reason: string; why: string }[]; categories?: string | null }, hooks: { reload: () => void } = { reload: () => undefined }): TemplateResult {
  const reasons = t.reasons ?? (t.reason ? [{ reason: t.reason, why: t.why ?? '' }] : []);
  const has = (r: string) => reasons.find((x) => x.reason === r);
  const picks = t.suggestions ?? [];
  const attempt = async (what: () => Promise<unknown>, done: string) => {
    try { await what(); toast(done); } catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); }
    hooks.reload();
  };
  const decide = async (categoryId: number, i: number | null) => {
    const sug = i === null ? undefined : picks[i];
    const { ok, remember } = await confirmCategorize(env, [t], categoryId, { suggestedBy: sug?.why, defaultRemember: !!sug && sug.why !== 'rule' });
    if (!ok) return;
    await attempt(() => env.categorize([t.id], categoryId, remember), `Categorized as ${env.cats.find((c) => c.id === categoryId)?.name ?? 'the category'}`);
  };
  const patch = (body: unknown) => api.patch(`/api/transactions/${t.id}`, body);
  const typeNote = async () => { const n = await promptBox({ title: 'What was this for?', label: 'Note', value: t.note ?? '', confirm: 'Save note' }); if (n?.trim()) await attempt(() => patch({ note: n.trim() }), 'Note saved'); };
  const pickNote = async () => {
    const c: any[] = await api.get(`/api/transactions/${t.id}/note-candidates`);
    const chosen = await showDialog<any>((close) => html`<h3 class="title">Which note is this?</h3>${c.length ? html`<div class="option-list">${c.slice(0, 8).map((n) => html`<button class="option" @click=${() => close(n)}><span class="name">${n.note || '(no note)'}</span><span class="muted small">${n.source} · ${fmtDate(n.occurred_on)}${n.counterparty ? ` · ${n.counterparty}` : ''}</span></button>`)}</div>` : html`<p class="muted">No imported note matches this amount yet. Import the matching Amazon, Venmo or PayPal export on the Imports page, or type one.</p>`}<div class="actions"><button @click=${() => close(undefined)}>Close</button></div>`);
    if (chosen) await attempt(() => api.post(`/api/transactions/${t.id}/note`, { noteId: chosen.id }), 'Note attached');
  };
  const check = (state: 'missing' | 'ok' | 'none', label: string, value: unknown, why: string | undefined, actions: unknown, kind: string) => html`<div class="check ${state}" data-check=${kind}>
    <span class="mark" aria-label=${state === 'missing' ? 'missing' : state === 'ok' ? 'done' : 'not needed'}>${state === 'missing' ? '?' : state === 'ok' ? '✓' : '–'}</span>
    <div class="grow"><div><b>${label}</b> <span class=${state === 'ok' ? '' : 'muted'}>${value}</span></div>${why ? html`<div class="muted small why-text"><span aria-hidden="true">ⓘ</span> ${why}</div>` : nothing}${state === 'missing' && kind === 'category' ? picker : nothing}</div>
    <div class="check-actions">${actions}</div></div>`;
  // category: the best guess is one tap; the other suggestions and the full search live in an expandable panel so the card stays short
  const picker = html`<details class="picker"><summary>${picks.length > 1 ? 'Other suggestions and search' : 'Search all categories'}</summary>
    <div class="option-list" style="margin:8px 0">${picks.slice(1).map((p, i) => { const r = env.rows.find((x) => x.id === p.id);
      return html`<button class="option" @click=${() => decide(p.id, i + 1)}><span class="name">${p.name}</span><span class="muted small">${whyLabel[p.why] ?? p.why}</span><span class="meta">${r?.currentCents !== undefined && r?.currentCents !== null ? `${money(r.currentCents)} balance` : ''}</span></button>`; })}</div>
    <div class="row">${catSelect(env.cats, null, (id) => { if (id) void decide(id, null); }, { placeholder: 'Search all categories…' })}</div></details>`;
  const best = picks[0];
  const catState = has('needs_category') ? 'missing' : t.categories ? 'ok' : 'none';
  const catActions = has('needs_category')
    ? (best ? html`<button class="primary quick" title=${whyLabel[best.why] ?? best.why} @click=${() => decide(best.id, 0)}>Use ${best.name}</button>` : nothing)
    : html`<details class="picker inline"><summary>Change</summary><div class="row" style="margin-top:6px">${catSelect(env.cats, null, (id) => { if (id) void decide(id, null); }, { placeholder: 'Search all categories…' })}</div></details>`;
  const noteState = has('needs_note') ? 'missing' : t.note ? 'ok' : 'none';
  const noteActions = has('needs_note')
    ? html`<button class="note-pick" @click=${pickNote}>Matching notes</button><button class="note-add" @click=${typeNote}>Type</button><button class="note-none" @click=${() => attempt(() => patch({ noteState: 'not_needed' }), 'Marked: no note needed')}>None needed</button>`
    : html`<button class="note-add" @click=${typeNote}>${t.note ? 'Edit' : 'Add a note'}</button>`;
  const shown = t.effective_cents ?? t.amount_cents;
  return html`<div class="card txn" data-id=${t.id}><div class="row"><b class="grow">${t.descriptor_clean || t.descriptor_raw}</b>${amt(shown)}</div>
    <div class="muted small">${fmtDate(t.occurred_on)}${t.status === 'provisional' ? html` · <span class="badge warn">pending</span>` : nothing}</div>
    <div class="checklist">
      ${check(catState, 'Category', catState === 'missing' ? 'Not set' : t.categories ?? 'None', has('needs_category')?.why, catActions, 'category')}
      ${check(noteState, 'Note', noteState === 'missing' ? 'Needed' : t.note ? `“${t.note}”` : 'None', has('needs_note')?.why, noteActions, 'note')}
      ${has('flagged') ? check('missing', 'Flag', t.flag_reason ?? 'Flagged for follow-up', has('flagged')!.why, html`<button class="unflag primary" @click=${() => attempt(() => patch({ flagged: 0 }), 'Flag cleared')}>Mark reviewed</button>`, 'flag') : nothing}
      ${has('stale') ? check('missing', 'Posted', 'Never posted', has('stale')!.why, html`<button class="hide-stale" @click=${() => attempt(() => api.post(`/api/transactions/${t.id}/ignore`, { reason: 'pending charge never posted' }), 'Hidden')}>Hide it</button>`, 'stale') : nothing}
    </div>
    <details class="more"><summary>Details</summary>
      <div class="muted small" style="margin-top:8px">${t.account}${t.status === 'provisional' ? ' · pending, not posted yet' : ''}</div>
      <div style="margin-top:8px">${fullLine(t)}</div>
      <div class="row" style="margin-top:10px"><button @click=${() => showContext(t)}>Show nearby transactions</button>${env.ignore ? html`<button data-tip=${NOT_A_BUDGET_ITEM} @click=${() => attempt(() => env.ignore!(t), 'Marked: not a budget item')}>Not a budget item</button>` : nothing}</div>
    </details></div>`;
}
