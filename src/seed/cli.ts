/** Usage: tsx src/seed/cli.ts <command> [...]
 *   init [--user "Name:email" ...]      create accounts + ingest tokens (prints secrets once)
 *   migrate --dir <exports> --asof YYYY-MM-DD [--oracle <dir>]   import sheet CSVs, then run parity if oracle files exist
 *   seed-rules --guesser <IFTTT_guess.gs>   convert the old categorizer into rules
 *   backtest-rules                        compare the seeded rules with every categorized historical transaction
 *   demo                                  load fictional data to try the UI
 *   profiles                              create Greenlight profiles (needs categories)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../core/db.js';
import { seedHousehold, seedGreenlightProfiles, seedCoreRules } from './household.js';
import { importSheets } from '../migration/sheet.js';
import { runParity, formatParity } from '../migration/parity.js';
import { seedFromGuesser } from './guesser.js';
import { backtestHistory } from './backtest.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const all = (n: string) => rest.flatMap((x, i) => (x === `--${n}` ? [rest[i + 1]] : []));
const db = openDb(`${process.env.HK_DATA_DIR ?? './data'}/hearthkeeper.sqlite`);
const read = (p: string) => readFileSync(p, 'utf8');

if (cmd === 'init') {
  const users = all('user').map((u) => { const [name, email] = u.split(':'); return { name, email }; });
  console.log(JSON.stringify(seedHousehold(db, { users }), null, 2));
  seedCoreRules(db);
} else if (cmd === 'migrate') {
  const dir = flag('dir')!, asOf = flag('asof')!;
  const rep = importSheets(db, { list: read(join(dir, 'List.csv')), history: read(join(dir, 'History.csv')), budget: read(join(dir, 'Budget.csv')), transactions: read(join(dir, 'Transactions.csv')) });
  console.log(JSON.stringify({ ...rep, legacySplitGroups: rep.legacySplitGroups.filter((g) => !g.balanced) }, null, 2));
  const od = flag('oracle') ?? dir;
  const f = (n: string) => (existsSync(join(od, n)) ? read(join(od, n)) : undefined);
  
  const parity = runParity(db, asOf, { internalAB: f('oracle_internal_AB.csv'), internalHJ: f('oracle_internal_HJ.csv'), budgetCurrent: f('oracle_budget_current.csv'), periods: f('oracle_periods.csv'), periodsMonth: f('oracle_periods_month.txt')?.trim(), allocated: f('oracle_allocated.txt'),
    txnCount: f('oracle_txn_count.txt') ? Number(f('oracle_txn_count.txt')) : undefined, txnTotal: f('oracle_txn_total.txt')?.trim() });
  console.log(formatParity(parity));
  process.exitCode = parity.passed ? 0 : 1;
} else if (cmd === 'seed-rules') {
  console.log(JSON.stringify(seedFromGuesser(db, read(flag('guesser')!)), null, 2));
} else if (cmd === 'backtest-rules') {
  const r = backtestHistory(db);
  console.log(JSON.stringify({ ...r, byDisagreement: r.byDisagreement.slice(0, 40), byUnmatchedActual: r.byUnmatchedActual.slice(0, 40) }, null, 2));
} else if (cmd === 'demo') {
  const { seedDemo } = await import('./demo.js');
  seedDemo(db, new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }));
  console.log('Demo data loaded (fictional). Start with: HK_AUTH=dev npm start');
} else if (cmd === 'profiles') {
  const missing = seedGreenlightProfiles(db);
  console.log(missing.length ? `Missing categories (create them first): ${missing.join(', ')}` : 'Greenlight profiles ready');
} else console.log(read(new URL(import.meta.url).pathname).split('*/')[0]);
