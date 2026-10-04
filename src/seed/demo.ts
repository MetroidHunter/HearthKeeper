/** Demo database for trying the UI: `npm run hk -- demo` (never use against real data). Everything here is fictional. */
import type { DB } from '../core/db.js';
import { addCategory } from '../core/categories.js';
import { seedHousehold, seedGreenlightProfiles, seedCoreRules } from './household.js';
import { createTransaction, setSplits, classify } from '../core/transactions.js';
import { createScenario } from '../core/earnings.js';
import { createPlan, assignScenario, makeLive } from '../core/plans.js';
import { addRule } from '../core/rules.js';
import { captureEvent, createToken } from '../ingest/events.js';
import { processGreenlightMessage } from '../greenlight/engine.js';
import { registerGreenlightParser } from '../greenlight/parser.js';
import { parseEvent } from '../ingest/events.js';

export function seedDemo(db: DB, today: string) {
  const month = today.slice(0, 7);
  const start = `${Number(month.slice(0, 4)) - 1}-01`;
  seedHousehold(db, { users: [{ name: 'Brys', email: 'brys@example.com' }, { name: 'Miracle', email: 'miracle@example.com' }] });
  const cats: Record<string, number> = {};
  for (const [name, group, cents, kind] of [['Groceries', 'Food', 80000, 'expense'], ['Eating Out', 'Food', 30000, 'expense'], ['Gas', 'Transportation', 15000, 'expense'], ['Car Insurance', 'Transportation', 20000, 'expense'],
    ['Mortgage', 'Housing', 220000, 'expense'], ['Utilities', 'Housing', 30000, 'expense'], ['Pets', 'Home', 8000, 'expense'], ['Fees and Taxes', 'Misc', 1000, 'expense'], ['Miracle Spending', 'Family', 5000, 'expense'], ['Family Support', 'Family', 40000, 'expense'],
    ['Gig Income', 'Income', 0, 'income_pool'], ['Salary', 'Income', 0, 'income_reference']] as const)
    cats[name] = addCategory(db, { name, group, startMonth: start, monthlyCents: cents, kind, discretionary: !['Mortgage', 'Utilities', 'Car Insurance'].includes(name), cushionCents: name === 'Utilities' ? 5000 : undefined });
  db.prepare('UPDATE categories SET overage_priority=1 WHERE name=?').run('Groceries');
  seedGreenlightProfiles(db); seedCoreRules(db);
  const chase = (db.prepare("SELECT id FROM accounts WHERE name='Chase Prime Visa'").get() as any).id;
  const wf = (db.prepare("SELECT id FROM accounts WHERE name='Wells Fargo Brys'").get() as any).id;
  for (const [pat, cat] of [['safeway', 'Groceries'], ['trader joe', 'Groceries'], ['chipotle', 'Eating Out'], ['shell', 'Gas'], ['state farm', 'Car Insurance']] as const)
    addRule(db, { match: { all_of: [{ field: 'descriptor', op: 'contains', value: pat }] }, action: { type: 'categorize', category: cat }, mode: 'auto', origin: 'legacy_guesser' });
  const day = (n: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const rows: [number, number, string, string][] = [[3, -8412, 'SAFEWAY #1234 SEATTLE WA', 'chase'], [4, -1420, 'CHIPOTLE 2331', 'chase'], [5, -4210, 'SEPHORA #182 SEATTLE WA', 'chase'], [6, -5200, 'SHELL OIL 5742', 'chase'], [7, -2399, 'AMZN Mktp US*2K4LM9', 'chase'], [9, -12000, 'STATE FARM RO 1283985715', 'wf'],
    [10, -9400, 'SQ *NEW CAFE', 'chase'], [11, 640000, 'SEQUOIA PAYROLL DIRECT DEP', 'wf'], [12, -350000, 'ROCKET MORTGAGE LOAN', 'wf'], [2, -50000, 'CHASE CREDIT CRD AUTOPAY 261003', 'wf']];
  for (const [ago, cents, desc, a] of rows) {
    const id = createTransaction(db, { accountId: a === 'chase' ? chase : wf, occurredOn: day(ago), amountCents: cents, descriptor: desc, kind: cents < 0 ? 'spending' : 'income' });
    classify(db, id);
  }
  const sal = createTransaction(db, { accountId: wf, kind: 'income', occurredOn: day(11), amountCents: 0, descriptor: 'noop' }); void sal;
  db.prepare("DELETE FROM transactions WHERE descriptor_raw='noop'").run();
  const sc = createScenario(db, 'Brys $220k @ 32%', [{ person: 'Brys', label: 'Salary', annualSalaryCents: 22000000, taxRateBp: 3200 }]);
  const plan = createPlan(db, 'Current budget', { livePlan: true }, month);
  assignScenario(db, plan, sc);
  makeLive(db, plan, { effectiveMonth: month, today, actor: 'demo' });
  registerGreenlightParser();
  let n = 0;
  for (const m of ['$50.00 allowance transferred to Miracle', '$100.00 allowance transferred to Marion', 'Miracle spent $21.83 at El Rinconsito Seattle', 'Marion spent $7.07 at WAL-MART #3658 GREENSBORO NC', 'they can no longer use their debit card with payment apps', 'Marion\'s Greenlight card is on the way! 📫'])
    { const c = captureEvent(db, { source: 'greenlight_msg', channel: 'device', payload: `${m} on October 3, 2026 at 0${++n}:15PM` }); parseEvent(db, c.id); }
  captureEvent(db, { source: 'chase_alert', channel: 'email', payload: 'Chase: You made a $9.40 transaction with SQ *NEW CAFE on Oct 3, 2026 at 4:11 PM ET' });
  void processGreenlightMessage; void createToken; void setSplits;
}
