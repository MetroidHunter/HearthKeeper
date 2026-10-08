import { describe, it, expect, beforeEach } from 'vitest';
import { seedHousehold } from './helpers.js';
import { commitImport } from '../src/ingest/import.js';
import { suggestMapping, parseCsv } from '../src/ingest/csv.js';
import { captureEvent, parseEvent, clearParsers } from '../src/ingest/events.js';
import { registerAllParsers } from '../src/ingest/parsers.js';
import { createTransaction } from '../src/core/transactions.js';
import { dedupeAgainstHistory } from '../src/ingest/history.js';

/**
 * "Extra super certain": however the same real payments reach the system (a real-time alert, a bank file, the same file again, an overlapping file,
 * the alert arriving after the file, history imported from the old sheet), each one is counted exactly once, with twins (two identical payments) kept as two.
 */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const shuffle = <T,>(r: () => number, xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const counted = (db: any) => db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) s FROM transactions WHERE status!='void' AND kind IN ('spending','income')").get() as { c: number; s: number };
const HDR = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const iso = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
beforeEach(() => { clearParsers(); registerAllParsers(); });

describe('Chase: alerts and bank files in any order, repeated and overlapping', () => {
  const VENDORS: [string, string][] = [['SQ *BLUE BOTTLE', 'BLUE BOTTLE COFFEE SEATTLE WA'], ['TRADER JOES', 'TRADER JOE S #123 SEATTLE WA'], ['SHELL OIL', 'SHELL OIL 57422 BELLEVUE WA'], ['CHIPOTLE', 'CHIPOTLE 2331'],
    ['AMZN MKTP US', 'AMAZON MKTPLACE PMTS AMZN.COM/BILL WA'], ['UBER *EATS', 'UBER EATS HELP.UBER.COM CA'], ['STARBUCKS', 'STARBUCKS #55']];
  for (let seed = 1; seed <= 40; seed++) {
    it(`each payment is counted once (seed ${seed})`, () => {
      const r = rng(7000 + seed); const h = seedHousehold(); const db = h.db;
      const N = int(r, 6, 18);
      const txns = Array.from({ length: N }, (_, i) => { const [alert, csv] = pick(r, VENDORS); return { alert, csv, day: int(r, 1, 24), cents: -int(r, 1, 8) * 350, hasAlert: r() < 0.7, lag: int(r, 0, 2), minute: 10 + i }; });
      if (N > 3) for (const k of [0, 1]) txns.push({ ...txns[k], minute: 40 + k }); // twins: the same vendor, day and amount twice
      const total = txns.length;
      const file = (xs: typeof txns) => HDR + xs.map((t) => `${mdy(iso(t.day + t.lag))},${mdy(iso(t.day + t.lag))},${t.csv},Food,Sale,${(t.cents / 100).toFixed(2)},`).join('\n') + '\n';
      const importFile = (xs: typeof txns) => { if (!xs.length) return; const csv = file(xs); const m = suggestMapping(parseCsv(csv)); commitImport(db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }, { accountId: h.chase }); };
      const alert = (t: (typeof txns)[number]) => parseEvent(db, captureEvent(db, { source: 'chase_alert', channel: 'device', payload: `Prime Visa: You made a $${(-t.cents / 100).toFixed(2)} transaction with ${t.alert} on Oct ${t.day}, 2026 at 4:${String(t.minute).padStart(2, '0')} PM ET.` }).id);
      type Op = () => void;
      const ops: Op[] = [];
      for (const t of txns) if (t.hasAlert) ops.push(() => alert(t));
      for (let i = 0; i < 4; i++) { const sub = txns.filter(() => r() < 0.6); ops.push(() => importFile(sub)); } // overlapping partial files, some repeated
      const order = shuffle(r, ops);
      for (const op of order) op();
      importFile(txns); importFile(txns); // the full file, and the same file again
      for (const t of txns) if (t.hasAlert && r() < 0.3) alert(t); // a late or repeated alert for something the file already has
      if (process.env.DBG) console.log('TXNS', JSON.stringify(txns), '\n', JSON.stringify(db.prepare("SELECT id, status, kind, occurred_on d, amount_cents a, substr(descriptor_raw,1,40) x, fingerprint IS NOT NULL fp FROM transactions ORDER BY id").all()));
      expect(counted(db)).toEqual({ c: total, s: txns.reduce((a, t) => a + t.cents, 0) });
      expect((db.prepare("SELECT COUNT(*) c FROM transactions WHERE status='provisional'").get() as any).c, 'every alert was replaced by its posted row').toBe(0);
    });
  }
});

describe('Wells Fargo: alerts carry the bank text, files arrive per account', () => {
  const DESC = ['PURCHASE AUTHORIZED ON 10/DD ACE PARKING 3286 BELLVUE WA S306273081194346 CARD 4444', 'ROCKET MORTGAGE LOAN 261003 4288057 BRYS *SEPULVEDA', 'T-MOBILE PCS SVC 260920 9677020 BRYS SEPULVEDA',
    'PAYPAL PURCHASE 260928 HULU BRYS SEPULVEDA', 'Subscription Acorns 092126 5970Y9 Brys Sepulveda'];
  for (let seed = 1; seed <= 30; seed++) {
    it(`each payment is counted once (seed ${seed})`, () => {
      const r = rng(9000 + seed); const h = seedHousehold(); const db = h.db;
      db.prepare("UPDATE accounts SET last4='1111' WHERE id=?").run(h.wf);
      const txns = Array.from({ length: int(r, 4, 12) }, () => { const day = int(r, 1, 24); return { desc: pick(r, DESC).replace('10/DD', `10/${String(day).padStart(2, '0')}`), day, cents: -int(r, 1, 30) * 500, hasAlert: r() < 0.7, lag: int(r, 0, 3) }; });
      const csv = (xs: typeof txns) => '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n' + xs.map((t) => `"${mdy(iso(t.day + t.lag))}","${t.desc}","${(t.cents / 100).toFixed(2)}","","Posted"`).join('\n') + '\n';
      const importFile = (xs: typeof txns) => { if (!xs.length) return; const c = csv(xs); const m = suggestMapping(parseCsv(c)); commitImport(db, 'Wells Fargo', c, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }, { accountId: h.wf }); };
      const alert = (t: (typeof txns)[number]) => { const d = iso(t.day + t.lag).slice(5).replace('-', '/'); parseEvent(db, captureEvent(db, { source: 'wf_notice', channel: 'email', payload: `Here's the rundown for account ...1111 Withdrawals ${t.desc} $${(-t.cents / 100).toFixed(2)} As of ${d}/2026 at 02:26 a.m., Central Time`, dedupeKey: `a${Math.random()}` } as any).id); };
      const ops = [...txns.filter((t) => t.hasAlert).map((t) => () => alert(t)), ...[0, 1, 2].map(() => { const sub = txns.filter(() => r() < 0.6); return () => importFile(sub); })];
      for (const op of shuffle(r, ops)) op();
      importFile(txns); importFile(txns);
      for (const t of txns) if (t.hasAlert && r() < 0.4) alert(t);
      // identical payments (same text, day and amount) are legitimately separate, and a bank file lists each of them
      if (process.env.DBG) console.log('TXNS', JSON.stringify(txns), '\n', JSON.stringify(db.prepare("SELECT id, status, kind, occurred_on d, amount_cents a, substr(descriptor_raw,1,40) x, fingerprint IS NOT NULL fp FROM transactions ORDER BY id").all()));
      expect(counted(db)).toEqual({ c: txns.length, s: txns.reduce((a, t) => a + t.cents, 0) });
    });
  }
});

describe('History imported from the old sheet overlaps the first bank file', () => {
  const LEG = [['ROCKET MORTGAGE', -484492], ['T-MOBILE PCS SVC', -22746], ['GREENLIGHT APP', -15000], ['SEQUOIA ONE PEO, PAYROLL', 644316], ['STATE FARM RO 27 SFPP', -1400]] as const;
  it('a file overlapping the history adds only what is new; running it again, or the one-time clean-up, changes nothing', () => {
    const h = seedHousehold(); const db = h.db;
    const legacy = Number(db.prepare("INSERT INTO accounts(name,institution,type,in_system) VALUES ('Legacy','Legacy','bank',0)").run().lastInsertRowid);
    for (const [i, [d, c]] of LEG.entries()) createTransaction(db, { accountId: legacy, occurredOn: iso(1 + i), amountCents: c, descriptor: d, kind: c < 0 ? 'spending' : 'income' });
    db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='user'").run();
    const file = '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n"10/03/2026","ROCKET MORTGAGE LOAN 261003 4288057 BRYS *SEPULVEDA","-4844.92","","Posted"\n'.replace('-4844.92', '-4844.92')
      + '"10/01/2026","ROCKET MORTGAGE LOAN 261001 1 BRYS *SEPULVEDA","-4844.92","","Posted"\n"10/09/2026","NEW THING 1","-12.00","","Posted"\n"10/03/2026","GREENLIGHT       APP        261003 GREENLIGHT      BRYS SEPULVEDA","-150.00","","Posted"\n';
    const m = suggestMapping(parseCsv(file)); const sp = { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 };
    const before = counted(db);
    const r1 = commitImport(db, 'Wells Fargo', file, sp, { accountId: h.wf });
    expect(r1).toMatchObject({ imported: 2, alreadyInHistory: 2 }); // the 10/01 mortgage is history's 10/01 one, and Greenlight's 150 is history's; the 10/03 mortgage has no amount twin... see below
    expect(counted(db).c).toBe(before.c + 2);
    const r2 = commitImport(db, 'Wells Fargo', file, sp, { accountId: h.wf }); expect(r2.imported).toBe(0);
    expect(dedupeAgainstHistory(db)).toEqual({ duplicates: 0 });
    expect(counted(db).c).toBe(before.c + 2);
  });

  it('rows an earlier import already put on top of history are hidden once (keeping your answer), restorable, and a re-import cannot bring them back', () => {
    const h = seedHousehold(); const db = h.db;
    const legacy = Number(db.prepare("INSERT INTO accounts(name,institution,type,in_system) VALUES ('Legacy','Legacy','bank',0)").run().lastInsertRowid);
    const hist = createTransaction(db, { accountId: legacy, occurredOn: '2026-07-03', amountCents: -484492, descriptor: 'ROCKET MORTGAGE LOAN', kind: 'spending' });
    db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='user' WHERE id=?").run(hist);
    db.prepare("INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?, 'legacy')").run(hist, h.cats['Fees and Taxes'], -484492);
    // the old behaviour: the bank row was added as a second transaction (with a fingerprint), and the person categorized it
    const dup = createTransaction(db, { accountId: h.wf, occurredOn: '2026-07-03', amountCents: -484492, descriptor: 'ROCKET MORTGAGE  LOAN       260702 3681291         BRYS *SEPULVEDA', fingerprint: 'Wells Fargo|2026-07-03|-484492|X' });
    db.prepare("INSERT INTO transaction_splits(transaction_id,category_id,amount_cents,origin) VALUES (?,?,?, 'user')").run(dup, h.cats['Groceries'], -484492);
    db.prepare("UPDATE transactions SET review_state='user_confirmed', decided_by='user', note='check this' WHERE id=?").run(dup);
    expect(counted(db).c).toBe(2);
    expect(dedupeAgainstHistory(db)).toEqual({ duplicates: 1 });
    expect(counted(db).c).toBe(1);
    expect(db.prepare('SELECT kind, ignored_reason FROM transactions WHERE id=?').get(dup)).toEqual({ kind: 'ignored', ignored_reason: 'duplicate of earlier history' });
    expect(db.prepare('SELECT c.name n FROM transaction_splits s JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=?').get(hist)).toEqual({ n: 'Groceries' }); // your answer moved onto the history row
    expect(db.prepare('SELECT note FROM transactions WHERE id=?').get(hist)).toEqual({ note: 'check this' });
    expect(dedupeAgainstHistory(db)).toEqual({ duplicates: 0 });
  });
});

describe('what the importer cannot be sure about is shown, not hidden or silently dropped', () => {
  it('a bank row with the same amount as a history row but a different description is imported, and listed under "No duplicates" for a person to judge', async () => {
    const { monthsOverview } = await import('../src/core/months.js');
    const { buildApp } = await import('../src/server/app.js');
    const h = seedHousehold(); const db = h.db;
    const legacy = Number(db.prepare("INSERT INTO accounts(name,institution,type,in_system) VALUES ('Legacy','Legacy','bank',0)").run().lastInsertRowid);
    createTransaction(db, { accountId: legacy, occurredOn: '2026-10-05', amountCents: -5000, descriptor: 'FARMERS MARKET', kind: 'spending' });
    const csv = HDR + '10/05/2026,10/05/2026,ZZZ COMPLETELY DIFFERENT,Misc,Sale,-50.00,\n';
    const m = suggestMapping(parseCsv(csv));
    expect(commitImport(db, 'Chase', csv, { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 }, { accountId: h.chase })).toMatchObject({ imported: 1, alreadyInHistory: 0 });
    const oct = monthsOverview(db, '2026-10-20').find((x) => x.month === '2026-10')!;
    expect(oct.items.find((i) => i.key === 'dupes')!.count).toBe(1);
    const app = buildApp(db, { auth: { mode: 'dev', allowlist: [], sessionSecret: 'x' } });
    expect((await app.inject({ url: '/api/transactions?needs=dupes' })).json().map((t: any) => t.descriptor_raw)).toEqual(['ZZZ COMPLETELY DIFFERENT']);
  });
});

describe('the same bank line under two accounts of one bank', () => {
  it('is listed for review (never silently dropped, since two accounts can legitimately look alike)', async () => {
    const { monthsOverview } = await import('../src/core/months.js');
    const h = seedHousehold(); const db = h.db;
    const home = Number(db.prepare("INSERT INTO accounts(name,institution,type) VALUES ('Wells Fargo Home','Wells Fargo','bank')").run().lastInsertRowid);
    const file = '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n"10/03/2026","ROCKET MORTGAGE  LOAN       261003 4288057         BRYS *SEPULVEDA","-4844.92","","Posted"\n';
    const m = suggestMapping(parseCsv(file)); const sp = { columnMap: m.columnMap, dateFormat: m.dateFormat, signRule: m.signRule, skipRows: 0 };
    commitImport(db, 'Wells Fargo', file, sp, { accountId: h.wf }); commitImport(db, 'Wells Fargo', file, sp, { accountId: home }); // the same file, filed under two accounts
    expect(counted(db).c).toBe(2);
    expect(monthsOverview(db, '2026-10-20').find((x) => x.month === '2026-10')!.items.find((i) => i.key === 'dupes')!.count).toBe(2);
  });
});
