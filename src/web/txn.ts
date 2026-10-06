import { html, nothing, type TemplateResult } from 'lit';
import { api, money, fmtDate } from './api.js';
import { amt, pace } from './shared.js';
import { showDialog, alertBox, catSelect, type PickCat } from './ui.js';

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

/** One transaction that needs a person: full line, why, suggestions as real buttons, search for anything else. */
export function txnCard(env: Env, t: TxnLike & { reason?: string }, hooks: { reload: () => void } = { reload: () => undefined }): TemplateResult {
  const picks = t.suggestions ?? [];
  const decide = async (categoryId: number, i: number | null) => {
    const sug = i === null ? undefined : picks[i];
    const { ok, remember } = await confirmCategorize(env, [t], categoryId, { suggestedBy: sug?.why, defaultRemember: !!sug && sug.why !== 'rule' });
    if (!ok) return;
    try { await env.categorize([t.id], categoryId, remember); } catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); }
    hooks.reload();
  };
  return html`<div class="card txn" data-id=${t.id}><div class="row"><b class="grow">${t.descriptor_clean || t.descriptor_raw}</b>${amt(t.effective_cents ?? t.amount_cents)}</div>
    <div class="muted small">${fmtDate(t.occurred_on)} · ${t.account}${t.status === 'provisional' ? html` <span class="badge warn">pending</span>` : nothing}</div>
    <div style="margin-top:10px">${fullLine(t)}</div>
    ${t.why ? html`<div class="why" style="margin-top:10px"><span aria-hidden="true">ⓘ</span><span><b>Why this needs you:</b> ${t.why}</span></div>` : nothing}
    <h3 style="margin-top:14px">Pick a category</h3>
    <div class="option-list" style="margin-top:8px">${picks.length ? picks.map((p, i) => { const r = env.rows.find((x) => x.id === p.id);
      return html`<button class="option ${i === 0 ? 'best' : ''}" @click=${() => decide(p.id, i)}><span class="name">${p.name}</span>${i === 0 ? html`<span class="tag">Best match</span>` : nothing}<span class="muted small">${whyLabel[p.why] ?? p.why}</span>
        <span class="meta">${r?.currentCents !== undefined && r?.currentCents !== null ? `${money(r.currentCents)} balance` : ''}</span></button>`; }) : html`<div class="muted small">No suggestion: nothing matches yet. Search for the right category below.</div>`}</div>
    <div class="row" style="margin-top:10px"><span class="muted small">Something else:</span>${catSelect(env.cats, null, (id) => { if (id) void decide(id, null); }, { placeholder: 'Search all categories…' })}</div>
    <div class="row" style="margin-top:12px"><button @click=${() => showContext(t)}>Show nearby transactions</button>${env.ignore ? html`<button data-tip=${NOT_A_BUDGET_ITEM} @click=${async () => { try { await env.ignore!(t); } catch (e) { await alertBox('That did not save', `${(e as Error).message}. Nothing was changed.`); } hooks.reload(); }}>Not a budget item</button>` : nothing}</div></div>`;
}
