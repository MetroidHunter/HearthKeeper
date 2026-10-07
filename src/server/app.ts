import Fastify, { type FastifyInstance } from 'fastify';
import type { DB } from '../core/db.js';
import { audit } from '../core/db.js';
import { registerAuth, type AuthConfig } from './auth.js';
import { addCategory, budgetHistory, retireCategory, unretireCategory, setBudget } from '../core/categories.js';
import { budgetPage, budgetPie, explore, inbox, spendBy, monthPeriod, transactionContext } from '../core/reports.js';
import { createPlan, setPlanItem, assignScenario, diffPlan, makeLive, planHeader, bulkAdjust } from '../core/plans.js';
import { createScenario, scenarioLines, setScenarioLines, scenarioMonthlyNet, lineMetrics, cloneScenario } from '../core/earnings.js';
import { proposeRebalance, commitRebalance, placePool, manualTransfer, adjustment } from '../core/transfers.js';
import { monthlySpend, categoryTrend, incomeVsSpend, treemap, yearPivot, budgetVsActual } from '../core/analytics.js';
import { monthsOverview, NEEDS_WHERE } from '../core/months.js';
import { answerCategory, promotable } from '../core/answers.js';
import { setSplits, ignoreTransaction, restoreTransaction, createTransaction, classify } from '../core/transactions.js';
import { addRule, backtest, type RuleMatch } from '../core/rules.js';
import { categoryBalance, checkInvariants } from '../core/balance.js';
import { authenticate, captureEvent, shapes, decideShape, replay, parseEvent, silentTokens, createToken, type Source } from '../ingest/events.js';
import { previewImport, commitImport, coverage, markStale } from '../ingest/import.js';
import { suggestMapping, parseCsv } from '../ingest/csv.js';
import { processGreenlightMessage, createRequest, fundRequest, walletBalance, missingAllowances } from '../greenlight/engine.js';
import { extractText } from '../greenlight/parser.js';
import { Notifier, getPrefs, setPrefs } from '../notify/notifier.js';
import { vapidKeys } from '../notify/push.js';
import { registerAllParsers } from '../ingest/parsers.js';
import { backlogPage, groupedInbox, bulkAnswer } from '../core/backlog.js';
import { worksheetItems, applyWorksheet, loadReport } from '../migration/worksheet.js';
import { bootstrapMerchants } from '../migration/merchants.js';
import { noteCandidates, pickNote, proposeItemSplits } from '../notes/matcher.js';
import { importNotesCsv, runNoteMatcher } from '../notes/matcher.js';

/** Push endpoints are fetched by the server, so reject anything that is not https to a public host (SSRF). */
export function isPublicHttps(u: string): boolean {
  try {
    const x = new URL(u); const h = x.hostname.toLowerCase();
    if (x.protocol !== 'https:' || x.username || x.password) return false;
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80')) return false;
    return true;
  } catch { return false; }
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export interface AppOptions { auth: AuthConfig; notifier?: Notifier; verifyIdToken?: (idToken: string) => Promise<string | null>; staticDir?: string; now?: () => string }

export function buildApp(db: DB, opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 }); // 1 MB default; only the CSV import routes (behind auth) get more
  const BIG = { bodyLimit: 25 * 1024 * 1024 };
  app.addHook('onSend', async (req, reply) => { if ((req.routeOptions?.url ?? '').startsWith('/api/')) reply.header('cache-control', 'no-store'); }); // never let a proxy or the browser keep financial JSON
  const now = opts.now ?? today;
  registerAllParsers();
  registerAuth(app, opts.auth, opts.verifyIdToken);
  app.get('/healthz', async () => ({ ok: true }));
  const actor = (req: { user?: string }) => req.user ?? 'unknown';
  const rec = (v: unknown) => (v ?? {}) as Record<string, any>;

  /* ---------- ingest (token auth, capture first; design §8.5, §19.2) ---------- */
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  // Keep the exact bytes of JSON bodies: HMAC signatures are computed over what the sender sent, not a re-serialization.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });
  const ALLOWED_SOURCES: Record<'email' | 'device', string[]> = { device: ['greenlight_msg', 'chase_alert', 'wf_notice', 'device_unknown'], email: ['chase_alert', 'wf_notice', 'amazon_receipt', 'venmo_receipt', 'paypal_receipt', 'email_unknown'] };
  const ingest = (channel: 'email' | 'device', defaultSource: Source) => async (req: any, reply: any) => {
    const raw: string = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    // A secret in the URL ends up in proxy logs, so it is accepted only on the device channel (IFTTT cannot set headers or sign). Email must sign (HMAC) or use the Authorization header.
    const bearer = (channel === 'device' ? (req.query?.token as string | undefined) : undefined) ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const a = authenticate(db, { label: req.headers['x-hk-token'] as string, signature: req.headers['x-hk-signature'] as string, timestamp: req.headers['x-hk-timestamp'] as string, nonce: req.headers['x-hk-nonce'] as string, bearer, body: raw }, channel);
    if (!a.ok) return reply.code(401).send({ error: a.reason });
    const body = rec(req.body);
    const payload = typeof req.body === 'string' ? req.body : (body.text ?? body.payload ?? raw);
    // One phone automation can forward everything it sees: with no explicit source, a Chase card alert is recognised by its own wording.
    const sniffed: Source | undefined = channel === 'device' && typeof payload === 'string' && /Prime Visa: You made a \$/.test(payload) ? 'chase_alert' : undefined;
    const source = (req.query?.source as Source | undefined) ?? (body.source as Source | undefined) ?? sniffed ?? defaultSource;
    if (!ALLOWED_SOURCES[channel].includes(source)) return reply.code(400).send({ error: `source ${source} is not accepted on the ${channel} channel` }); // a leaked token must not be able to forge arbitrary sources
    const cap = captureEvent(db, { source, channel, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), html: channel === 'email' && typeof body.html === 'string' && body.html ? body.html.slice(0, 400_000) : null, headers: channel === 'email' ? body.headers : undefined, tokenId: a.tokenId, dedupeKey: body.messageId ? `${source}:${body.messageId}` : undefined });
    if (!cap.duplicate || cap.backfilled) parseEvent(db, cap.id); // no parser => stays pending; nothing is created
    return { id: cap.id, duplicate: cap.duplicate && !cap.backfilled };
  };
  app.post('/ingest/device', { bodyLimit: 256 * 1024 }, ingest('device', 'greenlight_msg'));
  app.post('/ingest/email', { bodyLimit: 1024 * 1024 }, ingest('email', 'email_unknown'));
  app.post('/ingest/heartbeat', { bodyLimit: 1024 }, async (req: any, reply) => {
    // heartbeat: HMAC-signed (empty body) like email ingest, or a header bearer; a URL secret only for the device channel
    const bearer = req.query?.token ? undefined : /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const args = { label: req.headers['x-hk-token'] as string, signature: req.headers['x-hk-signature'] as string, timestamp: req.headers['x-hk-timestamp'] as string, nonce: req.headers['x-hk-nonce'] as string, bearer, body: '' };
    const a = (() => { const e = authenticate(db, args, 'email'); if (e.ok) return e; const d = authenticate(db, args, 'device'); if (d.ok) return d; return req.query?.token ? authenticate(db, { bearer: req.query.token as string, body: '' }, 'device') : d; })();
    if (!a.ok) return reply.code(401).send({ error: a.reason });
    db.prepare("UPDATE ingest_tokens SET last_seen_at=datetime('now') WHERE id=?").run(a.tokenId);
    return { ok: true };
  });

  /* ---------- push + notification preferences (design §15.2, §15.3) ---------- */
  const userIdOf = (req: { user?: string }): number | null => {
    const u = req.user ? (db.prepare('SELECT id FROM users WHERE LOWER(email)=LOWER(?)').get(req.user) as { id: number } | undefined) : undefined;
    return u?.id ?? (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? null; // dev mode: the first user
  };
  app.get('/api/push/public-key', async () => ({ publicKey: vapidKeys(db).publicKey }));
  app.post('/api/push/subscribe', async (req: any, reply) => {
    const b = rec(req.body); const uid = userIdOf(req);
    if (!uid) return reply.code(400).send({ error: 'no user to attach the subscription to' });
    if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth) return reply.code(400).send({ error: 'endpoint and keys are required' });
    if (!isPublicHttps(String(b.endpoint))) return reply.code(400).send({ error: 'push endpoint must be a public https URL' }); // the server POSTs to this URL: no internal addresses
    db.prepare(`INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent`).run(uid, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? ''));
    return { ok: true };
  });
  // Only your own devices: a device list entry can be removed by its owner and nobody else.
  app.get('/api/push/devices', async (req: any) => { const uid = userIdOf(req); return uid ? db.prepare('SELECT id, endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE user_id=? ORDER BY id').all(uid) : []; });
  app.delete('/api/push/devices/:id', async (req: any) => { const uid = userIdOf(req); const n = uid ? db.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').run(Number(req.params.id), uid).changes : 0; return { removed: n }; });
  app.post('/api/push/unsubscribe', async (req: any) => { const uid = userIdOf(req); if (uid) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(rec(req.body).endpoint, uid); return { ok: true }; });
  app.post('/api/push/test', async (req: any, reply) => {
    const uid = userIdOf(req);
    if (!opts.notifier || !uid) return reply.code(400).send({ error: 'push is not configured on this server' });
    return { results: await opts.notifier.sendToUsers([uid], { title: 'HearthKeeper test', body: 'Push notifications work.', tag: 'test', url: '/#/' }, 'test', null, { ignoreQuiet: true }) };
  });
  app.get('/api/me/notify-prefs', async (req) => { const uid = userIdOf(req); return uid ? { ...getPrefs(db, uid), devices: (db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id=?').get(uid) as { c: number }).c } : null; });
  app.put('/api/me/notify-prefs', async (req) => { const uid = userIdOf(req); return uid ? setPrefs(db, uid, rec(req.body) as any) : null; });
  app.get('/api/digest', async () => (opts.notifier ?? new Notifier(db, { send: async () => 'ok' })).digest());

  /* ---------- reports ---------- */
  app.get('/api/budget', async (req: any) => budgetPage(db, req.query.today ?? now(), undefined, userIdOf(req) ?? undefined));
  app.get('/api/budget/pie', async (req: any) => budgetPie(db, req.query.today ?? now(), req.query.mode === 'spent' ? 'spent' : 'allocated'));
  app.get('/api/reports/spend-by', async (req: any) => spendBy(db, req.query.dim ?? 'category', { from: req.query.from ?? monthPeriod(now().slice(0, 7)).from, to: req.query.to ?? now() }));
  const q = (req: any) => req.query as Record<string, string>;
  const mon = () => now().slice(0, 7);
  const back = (n: number) => { const [y, m] = mon().split('-').map(Number); const i = y * 12 + m - 1 - n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
  app.get('/api/analytics/monthly', async (req) => monthlySpend(db, q(req).from ?? back(11), q(req).to ?? mon(), q(req).by === 'group' ? 'group' : 'category'));
  app.get('/api/analytics/trend/:id', async (req: any) => categoryTrend(db, Number(req.params.id), q(req).from ?? back(23), q(req).to ?? mon()));
  app.get('/api/analytics/income-vs-spend', async (req) => incomeVsSpend(db, q(req).from ?? back(11), q(req).to ?? mon()));
  app.get('/api/analytics/treemap', async (req) => treemap(db, q(req).from ?? back(11), q(req).to ?? mon()));
  app.get('/api/analytics/year-pivot', async (req) => yearPivot(db, Number(q(req).from ?? Number(mon().slice(0, 4)) - 4), Number(q(req).to ?? mon().slice(0, 4))));
  app.get('/api/analytics/budget-vs-actual', async (req) => budgetVsActual(db, q(req).month ?? mon()));
  app.get('/api/explore', async (req: any) => explore(db, String(req.query.q ?? ''), { from: req.query.from ?? '2020-01-01', to: req.query.to ?? now() }));
  app.get('/api/inbox', async (req: any) => inbox(db, now(), { limit: req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : undefined }));
  app.get('/api/backlog', async (req: any, reply) => { // one page of the Backlog (see backlogPage)
    const view = String(req.query.view ?? 'merchants'); if (!['merchants', 'flagged', 'notes'].includes(view)) return reply.code(400).send({ error: 'unknown view' });
    return backlogPage(db, { view: view as any, limit: Math.min(100, Math.max(1, Number(req.query.limit ?? 10))), offset: Math.max(0, Number(req.query.offset ?? 0)), q: req.query.q ? String(req.query.q) : undefined, today: now() });
  });
  app.get('/api/inbox/grouped', async () => groupedInbox(db));
  app.post('/api/inbox/bulk', async (req) => { const b = rec(req.body); return bulkAnswer(db, b.txnIds ?? [], b.categoryId, { makeRule: b.makeRule, actor: actor(req) }); });
  app.get('/api/dashboard', async () => {
    const months = monthsOverview(db, now());
    return { monthsNeedingWork: months.filter((m) => m.todo > 0).length, monthsOpenItems: months.reduce((a, m) => a + m.todo, 0), months: months.length, invariants: checkInvariants(db), coverage: coverage(db, now()), silentSources: silentTokens(db) };
  });

  app.get('/api/accounts', async () => db.prepare('SELECT id, name, institution, type, shared, in_system, last4 FROM accounts WHERE in_system=1 ORDER BY id').all());
  // last 4 digits identify which account an emailed bank alert belongs to ("for account ...5843"); unique per institution
  app.patch('/api/accounts/:id', async (req: any, reply) => {
    const v = rec(req.body).last4; const last4 = v === null || v === '' ? null : String(v).trim();
    if (last4 !== null && !/^\d{4}$/.test(last4)) return reply.code(400).send({ error: 'last 4 digits must be exactly 4 digits' });
    const a = db.prepare('SELECT institution FROM accounts WHERE id=?').get(Number(req.params.id)) as { institution: string } | undefined;
    if (!a) return reply.code(404).send({ error: 'no such account' });
    if (last4 && db.prepare('SELECT 1 FROM accounts WHERE institution=? AND last4=? AND id!=?').get(a.institution, last4, Number(req.params.id))) return reply.code(409).send({ error: `another ${a.institution} account already uses ${last4}` });
    db.prepare('UPDATE accounts SET last4=? WHERE id=?').run(last4, Number(req.params.id));
    return { ok: true };
  });

  /* ---------- categories & budgets ---------- */
  app.get('/api/categories', async () => db.prepare('SELECT c.*, g.name group_name FROM categories c LEFT JOIN category_groups g ON g.id=c.group_id ORDER BY g.name, c.name').all());
  app.post('/api/categories', async (req) => ({ id: addCategory(db, rec(req.body) as any, actor(req)) }));
  app.patch('/api/categories/:id', async (req: any) => {
    const b = rec(req.body); const id = Number(req.params.id);
    const cur = db.prepare('SELECT version FROM categories WHERE id=?').get(id) as any;
    if (b.version !== undefined && b.version !== cur.version) throw Object.assign(new Error('conflict: edited elsewhere'), { statusCode: 409 });
    for (const [k, col] of [['name', 'name'], ['discretionary', 'discretionary'], ['cushionCents', 'cushion_cents'], ['overagePriority', 'overage_priority']] as const)
      if (b[k] !== undefined) db.prepare(`UPDATE categories SET ${col}=?, version=version+1 WHERE id=?`).run(typeof b[k] === 'boolean' ? Number(b[k]) : b[k], id);
    audit(db, 'category', id, 'update', undefined, b, actor(req));
    return { ok: true };
  });
  app.post('/api/categories/:id/budget', async (req: any) => { const b = rec(req.body); setBudget(db, Number(req.params.id), b.monthlyCents, b.effectiveMonth ?? now().slice(0, 7), { reason: b.reason, actor: actor(req) }); return { ok: true }; });
  app.get('/api/categories/:id', async (req: any) => {
    const id = Number(req.params.id);
    return { category: db.prepare('SELECT * FROM categories WHERE id=?').get(id), balance: categoryBalance(db, id, now()), history: budgetHistory(db, id),
      rules: db.prepare("SELECT * FROM rules WHERE action_json LIKE ?").all(`%"${(db.prepare('SELECT name FROM categories WHERE id=?').get(id) as any)?.name}"%`),
      transactions: db.prepare('SELECT t.* FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE s.category_id=? ORDER BY t.occurred_on DESC LIMIT 100').all(id) };
  });
  app.post('/api/categories/:id/retire', async (req: any) => { const b = rec(req.body); return retireCategory(db, Number(req.params.id), b.month ?? now().slice(0, 7), { moveBalanceTo: b.moveBalanceTo, actor: actor(req) }); });
  app.post('/api/categories/:id/unretire', async (req: any) => { const b = rec(req.body); return unretireCategory(db, Number(req.params.id), b.month ?? now().slice(0, 7), { monthlyCents: b.monthlyCents, actor: actor(req) }); });
  app.post('/api/favorites', async (req: any) => { const b = rec(req.body); db.prepare('INSERT OR IGNORE INTO favorites(user_id, category_id) VALUES (?,?)').run(userIdOf(req) ?? 1, b.categoryId); return { ok: true }; });
  app.delete('/api/favorites/:categoryId', async (req: any) => { db.prepare('DELETE FROM favorites WHERE user_id=? AND category_id=?').run(userIdOf(req) ?? 1, Number(req.params.categoryId)); return { ok: true }; });

  /* ---------- earnings & plans ---------- */
  app.get('/api/scenarios', async () => (db.prepare('SELECT * FROM earning_scenarios ORDER BY id DESC').all() as any[]).map((s) => ({ ...s, lines: scenarioLines(db, s.id).map((l) => ({ ...l, ...lineMetrics(l) })), monthlyNetCents: scenarioMonthlyNet(db, s.id) })));
  app.post('/api/scenarios', async (req) => { const b = rec(req.body); return { id: createScenario(db, b.name, b.lines, b.notes) }; });
  app.put('/api/scenarios/:id/lines', async (req: any) => { setScenarioLines(db, Number(req.params.id), rec(req.body).lines); return { ok: true }; });
  app.post('/api/scenarios/:id/clone', async (req: any) => ({ id: cloneScenario(db, Number(req.params.id), rec(req.body).name) }));
  app.get('/api/plans', async () => (db.prepare('SELECT * FROM budget_plans ORDER BY id DESC').all() as any[]).map((p) => ({ ...p, ...planHeader(db, p.id) })));
  app.get('/api/plans/:id', async (req: any) => ({ plan: db.prepare('SELECT * FROM budget_plans WHERE id=?').get(req.params.id), header: planHeader(db, Number(req.params.id)),
    items: db.prepare('SELECT i.*, c.name FROM budget_plan_items i JOIN categories c ON c.id=i.category_id WHERE plan_id=? ORDER BY c.name').all(req.params.id) }));
  app.post('/api/plans', async (req) => { const b = rec(req.body); return { id: createPlan(db, b.name, b.from === 'live' ? { livePlan: true } : b.fromPlanId ? { planId: b.fromPlanId } : 'blank', b.month ?? now().slice(0, 7)) }; });
  app.put('/api/plans/:id/items/:cat', async (req: any) => { setPlanItem(db, Number(req.params.id), Number(req.params.cat), rec(req.body).monthlyCents, rec(req.body).note); return { ok: true }; });
  app.post('/api/plans/:id/bulk', async (req: any) => { bulkAdjust(db, Number(req.params.id), rec(req.body)); return { ok: true }; });
  app.put('/api/plans/:id/scenario', async (req: any) => { assignScenario(db, Number(req.params.id), rec(req.body).scenarioId ?? null); return { ok: true }; });
  app.get('/api/plans/:id/diff', async (req: any) => diffPlan(db, Number(req.params.id), req.query.month ?? now().slice(0, 7), now()));
  app.post('/api/plans/:id/make-live', async (req: any) => { const b = rec(req.body); return makeLive(db, Number(req.params.id), { effectiveMonth: b.effectiveMonth ?? now().slice(0, 7), actor: actor(req), today: now(), confirmRestate: b.confirmRestate }); });

  /* ---------- transactions ---------- */
  const txnFilter = (q: any) => {
    const where: string[] = ["t.status!='void'"]; const args: unknown[] = [];
    if (q.from) { where.push('t.occurred_on>=?'); args.push(q.from); } if (q.to) { where.push('t.occurred_on<=?'); args.push(q.to); }
    if (q.account) { where.push('t.account_id=?'); args.push(q.account); }
    if (q.category) { where.push('EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id AND s.category_id=?)'); args.push(q.category); }
    if (q.kind) { where.push('t.kind=?'); args.push(q.kind); }
    if (q.hidden !== '1') where.push("t.kind NOT IN ('ignored','internal_transfer')");
    if (q.needs) { if (!NEEDS_WHERE[q.needs]) throw Object.assign(new Error('unknown filter'), { statusCode: 400 }); where.push(`(${NEEDS_WHERE[q.needs]})`); } // a "fix it" link from the Months checklist
    if (q.q) { where.push('(LOWER(t.descriptor_raw) LIKE ? OR LOWER(COALESCE(t.note,\'\')) LIKE ?)'); args.push(`%${String(q.q).toLowerCase()}%`, `%${String(q.q).toLowerCase()}%`); }
    return { where, args };
  };
  app.get('/api/transactions/count', async (req: any) => { const { where, args } = txnFilter(req.query); return { total: (db.prepare(`SELECT COUNT(*) c FROM transactions t WHERE ${where.join(' AND ')}`).get(...args) as { c: number }).c }; });
  app.get('/api/transactions', async (req: any) => {
    const q = req.query; const { where, args } = txnFilter(q);
    const rows = db.prepare(`SELECT t.*, a.name account FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE ${where.join(' AND ')} ORDER BY t.occurred_on DESC, t.id DESC LIMIT ? OFFSET ?`).all(...args, Number(q.limit ?? 100), Number(q.offset ?? 0)) as any[];
    const sp = db.prepare('SELECT s.*, c.name category FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id WHERE transaction_id=?');
    return rows.map((r) => ({ ...r, splits: sp.all(r.id) }));
  });
  app.post('/api/transactions', async (req) => { // quick add (manual / cash)
    const b = rec(req.body);
    const id = createTransaction(db, { accountId: b.accountId, occurredOn: b.occurredOn ?? now(), amountCents: b.amountCents, descriptor: b.descriptor ?? 'Manual entry', kind: b.amountCents < 0 ? 'spending' : 'income', note: b.note });
    if (b.categoryId) setSplits(db, id, [{ categoryId: b.categoryId, amountCents: b.amountCents }], 'user'); else classify(db, id);
    return { id };
  });
  app.post('/api/transactions/:id/categorize', async (req: any) => {
    const b = rec(req.body); const id = Number(req.params.id);
    const t = db.prepare('SELECT amount_cents FROM transactions WHERE id=?').get(id) as any;
    const splits = b.splits ?? [{ categoryId: b.categoryId, amountCents: t.amount_cents }];
    const out = answerCategory(db, id, splits, { makeRule: b.makeRule, actor: actor(req) });
    void opts.notifier?.retract(id, userIdOf(req)); // the first answer closes the prompt on the other phone
    return out;
  });
  app.post('/api/transactions/:id/ignore', async (req: any) => { ignoreTransaction(db, Number(req.params.id), rec(req.body).reason ?? 'user', actor(req)); return { ok: true }; });
  app.post('/api/transactions/:id/restore', async (req: any) => { restoreTransaction(db, Number(req.params.id)); return { ok: true }; });
  app.patch('/api/transactions/:id', async (req: any) => {
    const b = rec(req.body); const id = Number(req.params.id);
    const cur = db.prepare('SELECT version FROM transactions WHERE id=?').get(id) as any;
    if (b.version !== undefined && b.version !== cur.version) throw Object.assign(new Error('conflict: edited elsewhere'), { statusCode: 409 });
    if (b.note !== undefined) db.prepare("UPDATE transactions SET note=?, note_state='user_provided', note_source='manual', version=version+1 WHERE id=?").run(b.note, id);
    if (b.noteState === 'not_needed') db.prepare("UPDATE transactions SET note_state='not_needed', version=version+1 WHERE id=?").run(id); // "this one needs no note"
    if (b.flagged !== undefined) db.prepare('UPDATE transactions SET flagged=?, flag_reason=?, version=version+1 WHERE id=?').run(Number(b.flagged), b.flagReason ?? null, id);
    audit(db, 'transaction', id, 'update', undefined, b, actor(req));
    return { ok: true };
  });
  /* ---------- notes: confirm a match, assign items (design §10, §15.4) ---------- */
  app.get('/api/transactions/:id/context', async (req: any, reply) => transactionContext(db, Number(req.params.id), Number(req.query.before ?? 6), Number(req.query.after ?? 6)) ?? reply.code(404).send({ error: 'not found' }));
  app.get('/api/transactions/:id/note-candidates', async (req: any) => noteCandidates(db, Number(req.params.id)));
  app.post('/api/transactions/:id/note', async (req: any) => { const b = rec(req.body); const id = Number(req.params.id); if (b.noteId) pickNote(db, id, b.noteId); else db.prepare("UPDATE transactions SET note=?, note_state='user_provided', note_source='manual', version=version+1 WHERE id=?").run(String(b.note ?? ''), id); audit(db, 'transaction', id, 'note', undefined, b, actor(req)); return { ok: true }; });
  app.get('/api/transactions/:id/item-splits', async (req: any) => proposeItemSplits(db, Number(req.params.id)));
  app.get('/api/transactions/:id/history', async (req: any) => db.prepare("SELECT id, action, before_json, after_json, actor, at FROM audit_log WHERE entity IN ('transaction','transaction_splits') AND entity_id=? ORDER BY id DESC").all(String(req.params.id)));
  app.get('/api/audit', async (req: any) => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(req.query.limit ?? 200)));

  /* ---------- rules & merchants ---------- */
  app.get('/api/rules', async () => db.prepare('SELECT * FROM rules ORDER BY priority, id').all());
  app.post('/api/rules/backtest', async (req) => backtest(db, { match: rec(req.body).match as RuleMatch }));
  app.post('/api/rules', async (req) => { const b = rec(req.body); return { id: addRule(db, b as any), backtest: backtest(db, { match: b.match }) }; });
  app.patch('/api/rules/:id', async (req: any) => { const b = rec(req.body); if (b.mode) db.prepare('UPDATE rules SET mode=? WHERE id=?').run(b.mode, req.params.id); if (b.enabled !== undefined) db.prepare('UPDATE rules SET enabled=? WHERE id=?').run(Number(b.enabled), req.params.id);
    if (b.priority !== undefined) { const n = Number(b.priority); if (!Number.isInteger(n) || n < 1 || n > 9999) throw Object.assign(new Error('priority must be a whole number from 1 to 9999'), { statusCode: 400 }); db.prepare('UPDATE rules SET priority=? WHERE id=?').run(n, req.params.id); }
    return { ok: true }; });
  app.get('/api/rules/promotable', async () => promotable(db));
  app.get('/api/merchants', async (req: any) => { // paged and searchable: the household has thousands, and the page must never render them all
    const q = req.query; const where: string[] = []; const args: unknown[] = [];
    if (q.q) { where.push('LOWER(m.name) LIKE ?'); args.push(`%${String(q.q).toLowerCase()}%`); }
    if (q.review === 'unreviewed') where.push("m.review_state='unreviewed'");
    if (q.review === 'nodefault') where.push('m.default_category_id IS NULL AND EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_id=m.id)'); // the useful to-do list: shops you actually bought from, with no usual category yet
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(200, Number(q.limit ?? 50)), offset = Number(q.offset ?? 0);
    const rows = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id=m.id) txns FROM merchants m ${w} ORDER BY txns DESC, m.name LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) c FROM merchants m ${w}`).get(...args) as { c: number }).c;
    const unreviewed = (db.prepare("SELECT COUNT(*) c FROM merchants WHERE review_state='unreviewed'").get() as { c: number }).c;
    const withoutDefault = (db.prepare('SELECT COUNT(*) c FROM merchants m WHERE m.default_category_id IS NULL AND EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_id=m.id)').get() as { c: number }).c;
    return { rows, total, unreviewed, withoutDefault, limit, offset };
  });
  app.post('/api/merchants/:id/merge', async (req: any) => {
    const into = rec(req.body).intoId; const id = Number(req.params.id);
    db.transaction(() => { db.prepare('UPDATE transactions SET merchant_id=? WHERE merchant_id=?').run(into, id); db.prepare('UPDATE merchant_aliases SET merchant_id=? WHERE merchant_id=?').run(into, id);
      db.prepare('INSERT INTO merchant_aliases(merchant_id, match_type, pattern) SELECT ?, \'contains\', name FROM merchants WHERE id=?').run(into, id);
      db.prepare('DELETE FROM merchant_group_members WHERE merchant_id=?').run(id); db.prepare('DELETE FROM merchants WHERE id=?').run(id); })();
    return { ok: true };
  });
  app.patch('/api/merchants/:id', async (req: any) => { const b = rec(req.body); if (b.name) db.prepare('UPDATE merchants SET name=?, review_state=\'reviewed\' WHERE id=?').run(b.name, req.params.id);
    if (b.defaultMode !== undefined && b.defaultCategoryId === undefined) { if (!['auto', 'suggest', 'ask'].includes(b.defaultMode)) return { error: 'bad mode' }; db.prepare("UPDATE merchants SET default_mode=?, review_state='reviewed' WHERE id=?").run(b.defaultMode, req.params.id); }
    if (b.defaultCategoryId !== undefined) db.prepare('UPDATE merchants SET default_category_id=?, default_mode=COALESCE(?, default_mode), review_state=\'reviewed\' WHERE id=?').run(b.defaultCategoryId, b.defaultMode ?? null, req.params.id); return { ok: true }; });
  app.post('/api/merchant-groups', async (req) => { const b = rec(req.body); const id = Number(db.prepare('INSERT INTO merchant_groups(name) VALUES (?)').run(b.name).lastInsertRowid); for (const m of b.merchantIds ?? []) db.prepare('INSERT OR IGNORE INTO merchant_group_members VALUES (?,?)').run(id, m); return { id }; });

  /* ---------- transfers & months ---------- */
  app.get('/api/transfers', async () => db.prepare('SELECT e.*, (SELECT json_group_array(json_object(\'categoryId\', category_id, \'cents\', amount_cents)) FROM envelope_transfer_legs WHERE transfer_id=e.id) legs FROM envelope_transfers e ORDER BY id DESC LIMIT 200').all());
  app.get('/api/transfers/rebalance', async (req: any) => proposeRebalance(db, req.query.asOf ?? now()));
  app.post('/api/transfers/rebalance', async (req) => commitRebalance(db, rec(req.body) as any, actor(req)));
  app.post('/api/transfers/place-pool', async (req) => { const b = rec(req.body); return { id: placePool(db, b.asOf ?? now(), b.poolCategoryId, b.allocations, actor(req)) }; });
  app.post('/api/transfers/manual', async (req) => { const b = rec(req.body); return { id: manualTransfer(db, b.date ?? now(), b.from, b.to, b.cents, b.memo, actor(req)) }; });
  app.post('/api/transfers/adjustment', async (req) => { const b = rec(req.body); return { id: adjustment(db, b.date ?? now(), b.categoryId, b.cents, b.reason, actor(req)) }; });
  app.get('/api/months', async () => monthsOverview(db, now())); // month by month: what still needs doing, and a few numbers

  /* ---------- imports ---------- */
  app.post('/api/imports/preview', BIG, async (req) => { const b = rec(req.body); return previewImport(db, b.institution, b.csv, b.spec, { accountId: b.accountId }); });
  app.post('/api/imports/suggest-mapping', BIG, async (req) => suggestMapping(parseCsv(rec(req.body).csv)));
  app.post('/api/imports/commit', BIG, async (req) => { const b = rec(req.body); return commitImport(db, b.institution, b.csv, b.spec, { accountId: b.accountId, filename: b.filename }); });
  app.post('/api/imports/notes', BIG, async (req) => { const b = rec(req.body); const n = importNotesCsv(db, b.csv, b.source ?? 'amazon'); return { ...n, ...runNoteMatcher(db) }; });
  app.get('/api/coverage', async () => coverage(db, now()));
  app.post('/api/maintenance/stale', async () => ({ stale: markStale(db, now()) }));

  /* ---------- migration review (design D32, §18.4) ---------- */
  app.get('/api/migration', async () => { const items = worksheetItems(db); return { report: loadReport(db), worksheet: items, total: items.reduce((a, i) => a + i.amountCents, 0) }; });
  app.post('/api/migration/apply', async (req) => applyWorksheet(db, rec(req.body).assignments ?? [], now(), actor(req)));
  app.post('/api/migration/merchants', async () => bootstrapMerchants(db));

  /* ---------- greenlight ---------- */
  app.get('/api/greenlight', async () => {
    const wallet = db.prepare("SELECT id FROM accounts WHERE type='greenlight_wallet' LIMIT 1").get() as any;
    return { profiles: db.prepare('SELECT p.*, c.name category FROM greenlight_profiles p JOIN categories c ON c.id=p.category_id').all(),
      requests: db.prepare("SELECT * FROM greenlight_requests ORDER BY id DESC LIMIT 50").all(), walletBalanceCents: wallet ? walletBalance(db, wallet.id) : null,
      missingAllowances: missingAllowances(db, now()), unrecognized: db.prepare("SELECT * FROM raw_events WHERE source='greenlight_msg' AND parse_status='unrecognized' ORDER BY id DESC LIMIT 50").all() };
  });
  app.patch('/api/greenlight/profiles/:id', async (req: any) => { const b = rec(req.body); for (const [k, c] of [['spendPolicy', 'spend_policy'], ['requestPolicy', 'request_policy'], ['withdrawPolicy', 'withdraw_policy'], ['categoryId', 'category_id']] as const) if (b[k] !== undefined) db.prepare(`UPDATE greenlight_profiles SET ${c}=? WHERE id=?`).run(b[k], req.params.id); return { ok: true }; });
  app.post('/api/greenlight/requests', async (req) => { const b = rec(req.body); return { id: createRequest(db, b.profileId, b.amountCents, b.requestedAt ?? now()) }; });
  app.post('/api/greenlight/requests/:id/approve', async (req: any) => ({ txnId: fundRequest(db, Number(req.params.id), now(), rec(req.body).categoryId) }));
  app.post('/api/greenlight/requests/:id/decline', async (req: any) => { db.prepare("UPDATE greenlight_requests SET status='declined' WHERE id=? AND status='pending'").run(req.params.id); return { ok: true }; });

  /* ---------- ingest health, shapes, replay ---------- */
  app.get('/api/ingest/health', async () => ({ perSource: db.prepare('SELECT source, COUNT(*) events, MAX(received_at) last_event, SUM(parse_status IN (\'unrecognized\',\'error\')) failed, SUM(parse_status=\'pending\') pending FROM raw_events GROUP BY source').all(), tokens: db.prepare('SELECT id, label, channel, last_seen_at, expected_cadence_hours FROM ingest_tokens').all(), silent: silentTokens(db) }));
  app.get('/api/shapes', async () => shapes(db));
  app.post('/api/shapes/decide', async (req) => { const b = rec(req.body); decideShape(db, b.fingerprint, b.source, b.decision); return { ok: true }; });
  app.post('/api/ingest/replay', async (req) => replay(db, rec(req.body)));
  app.get('/api/ingest/list', async (req: any) => { // paged: every message ever received is kept, so this list only ever grows
    const q = req.query; const where: string[] = []; const args: unknown[] = [];
    if (q.status) { where.push('parse_status=?'); args.push(String(q.status)); }
    if (q.source) { where.push('source=?'); args.push(String(q.source)); }
    if (q.q) { where.push('(LOWER(payload) LIKE ? OR LOWER(COALESCE(headers_json, \'\')) LIKE ?)'); const like = `%${String(q.q).toLowerCase().slice(0, 80)}%`; args.push(like, like); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(100, Number(q.limit ?? 25)), offset = Number(q.offset ?? 0);
    const rows = (db.prepare(`SELECT id, source, channel, received_at, parse_status, parser_version, error, substr(payload, 1, 160) preview, headers_json FROM raw_events ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[]).map(({ headers_json, ...r }) => {
      let h: Record<string, string> = {}; try { h = JSON.parse(headers_json ?? '{}'); } catch { /* none */ }
      return { ...r, subject: h.Subject ?? null, from: h['X-HK-Original-From'] ?? h.From ?? null };
    });
    const total = (db.prepare(`SELECT COUNT(*) c FROM raw_events ${w}`).get(...args) as { c: number }).c;
    const sources = (db.prepare('SELECT DISTINCT source FROM raw_events ORDER BY source').all() as { source: string }[]).map((r) => r.source);
    return { rows, total, sources, limit, offset };
  });
  app.get('/api/ingest/events/:id', async (req: any, reply) => {
    const r = db.prepare('SELECT id, source, channel, received_at, parse_status, parser_version, error, payload, html IS NOT NULL has_html, headers_json FROM raw_events WHERE id=?').get(Number(req.params.id)) as any;
    if (!r) return reply.code(404).send({ error: 'no such event' });
    let headers = {}; try { headers = JSON.parse(r.headers_json ?? '{}'); } catch { /* none */ }
    delete r.headers_json; return { ...r, payload: String(r.payload).slice(0, 20000), headers };
  });
  app.post('/api/ingest/events/:id/replay', async (req: any) => { const id = Number(req.params.id); const r = parseEvent(db, id); return { result: r ?? { status: 'pending', error: 'no parser for this source' } }; });
  app.post('/api/ingest/events/:id/noise', async (req: any) => { db.prepare("UPDATE raw_events SET parse_status='noise' WHERE id=? AND parse_status IN ('pending','unrecognized','error')").run(Number(req.params.id)); return { ok: true }; });
  app.get('/api/ingest/events', async (req: any) => db.prepare('SELECT id, source, channel, received_at, parse_status, error, payload FROM raw_events WHERE (? IS NULL OR parse_status=?) ORDER BY id DESC LIMIT 200').all(req.query.status ?? null, req.query.status ?? null));
  app.post('/api/ingest/tokens', async (req) => { const b = rec(req.body); return createToken(db, b.label, b.channel, b.expectedCadenceHours); }); // secret is shown once

  app.setErrorHandler((err: any, _req, reply) => {
    // only plain Errors thrown on purpose by our own validation are client errors; TypeError/RangeError/SqliteError are bugs or schema details
    const status = err.statusCode ?? (err.constructor === Error && /must|required|only|cannot|exceeds|requires|already|retroactive|not accepted|unknown|closed|closed/i.test(err.message) ? 400 : 500);
    if (status >= 500) { console.error('[error]', err); return reply.code(500).send({ error: 'internal error' }); } // never echo SQLite or stack details to a client
    reply.code(status).send({ error: err.message });
  });
  if (opts.staticDir) registerStatic(app, opts.staticDir);
  return app;
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function registerStatic(app: FastifyInstance, rawDir: string) {
  const dir = resolve(rawDir);
  app.get('/*', async (req, reply) => {
    const raw = req.url.split('?')[0];
    let p: string; try { p = decodeURIComponent(raw === '/' ? '/index.html' : raw); } catch { p = '/index.html'; }
    let f = p.includes('\0') ? join(dir, 'index.html') : resolve(dir, '.' + normalize(p));
    if ((f !== dir && !f.startsWith(dir + sep)) || !existsSync(f) || statSync(f).isDirectory()) f = join(dir, 'index.html'); // SPA fallback; never a path outside the static dir
    if (!existsSync(f)) return reply.code(404).send({ error: 'not found' });
    reply.header('content-type', MIME[extname(f)] ?? 'application/octet-stream');
    if (f.endsWith('sw.js')) reply.header('service-worker-allowed', '/');
    return reply.send(readFileSync(f));
  });
}
export { extractText, processGreenlightMessage };
