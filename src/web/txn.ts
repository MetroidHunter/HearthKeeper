import { html, nothing, render, type TemplateResult } from 'lit';
import { api, money, fmtDate, parseMoney } from './api.js';
import { amt, pace } from './shared.js';
import { showDialog, alertBox, promptBox, toast, catSelect, pendingBadge, withBusy, type PickCat } from './ui.js';

export interface BudgetRow { id: number; name: string; group: string | null; kind: string; targetCents: number; currentCents: number | null; spent: [number, number]; gained: [number, number] }
export interface Suggestion { id: number; name: string; why: string }
export interface TxnLike { kind?: string; id: number; occurred_on: string; amount_cents: number; effective_cents?: number; descriptor_raw: string; descriptor_clean?: string | null; account: string; status?: string; note?: string | null; note_state?: string; flag_reason?: string | null; why?: string; suggestions?: Suggestion[] }

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
  const decide = async (categoryId: number, i: number | null) => {
    const sug = i === null ? undefined : picks[i];
    const { ok, remember } = await confirmCategorize(env, [t], categoryId, { suggestedBy: sug?.why, defaultRemember: !!sug && sug.why !== 'rule' });
    if (!ok) return;
    await attempt(() => env.categorize([t.id], categoryId, remember), `Categorized as ${env.cats.find((c) => c.id === categoryId)?.name ?? 'the category'}`);
  };
  const patch = (body: unknown) => api.patch(`/api/transactions/${t.id}`, body);
  const saveNote = (v: string) => { const n = v.trim(); if (n) void attempt(() => patch({ note: n }), 'Note saved'); };
  const pickNote = async () => {
    const c: any[] = await api.get(`/api/transactions/${t.id}/note-candidates`);
    const chosen = await showDialog<any>((close) => html`<h3 class="title">Which note is this?</h3>${c.length ? html`<div class="option-list">${c.slice(0, 8).map((n) => html`<button class="option" @click=${() => close(n)}><span class="name">${n.note || '(no note)'}</span><span class="muted small">${n.source} · ${fmtDate(n.occurred_on)} · ${money(n.amount_cents)}</span></button>`)}</div>` : html`<p class="muted">No matching Amazon, Venmo or PayPal note yet. Type one in the box instead.</p>`}<div class="actions"><button @click=${() => close(undefined)}>Cancel</button></div>`);
    if (chosen) await attempt(() => api.post(`/api/transactions/${t.id}/note`, { noteId: chosen.id }), 'Note attached');
  };
  const best = picks[0];
  const catMissing = !!has('needs_category'), noteMissing = !!has('needs_note');
  const shown = t.effective_cents ?? t.amount_cents;
  const catCell = catMissing
    ? html`<span class="tcat-in">${catSelect(env.cats, null, (id) => { if (id) void decide(id, null); }, { placeholder: 'Category' })}${best ? html`<button class="quick" title=${`${whyLabel[best.why] ?? best.why}: use ${best.name}`} @click=${() => decide(best.id, 0)}>${best.name}</button>` : nothing}</span>`
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
      <div class="row">${!catMissing ? html`<span class="muted small">Change category:</span>${catSelect(env.cats, null, (id) => { if (id) void decide(id, null); }, { placeholder: 'Search all categories…' })}` : nothing}
        ${!noteMissing ? html`<span class="muted small">${t.note ? 'Edit note:' : 'Add a note:'}</span><input class="note-edit" placeholder="Note" .value=${t.note ?? ''} @change=${(e: any) => saveNote(e.target.value)} />` : nothing}</div>
      <div class="row"><button class="split-btn" ?hidden=${t.kind === 'greenlight_reclass'} @click=${async () => { const s = await splitDialog(env, t); if (s) await attempt(() => api.post(`/api/transactions/${t.id}/categorize`, { splits: s }), 'Split saved'); }}>Split…</button><button @click=${() => showContext(t)}>Show nearby transactions</button>${env.ignore ? html`<button data-tip=${NOT_A_BUDGET_ITEM} @click=${() => attempt(() => env.ignore!(t), 'Marked: not a budget item')}>Not a budget item</button>` : nothing}</div>
    </div></div>`;
}
