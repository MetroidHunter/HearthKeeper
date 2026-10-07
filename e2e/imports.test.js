import { expect, mount, reset, waitFor, $, $$, text, byText, trapErrors, api, choose } from './helpers.js';

const CHASE = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2026,10/02/2026,TRADER JOES #12 SEATTLE WA,Groceries,Sale,-45.10,
10/01/2026,10/02/2026,BRAND NEW MERCHANT,Shopping,Sale,-19.99,
10/01/2026,10/02/2026,BRAND NEW MERCHANT,Shopping,Sale,-19.99,
`;

function drop(app, name, csv) {
  const input = $('input[type=file]');
  const dt = new DataTransfer();
  dt.items.add(new File([csv], name, { type: 'text/csv' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Imports', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('maps a new layout once, previews, imports, preserves identical rows, and a re-upload is a no-op', async () => {
    const app = await mount('/imports');
    drop(app, 'chase.csv', CHASE);
    await waitFor(() => /map the columns once/i.test(text(document.body)), 'mapping wizard');
    expect($$('select').some((s) => text(s).includes('Amount'))).to.equal(true);
    byText('button', /Save mapping/).click();
    await waitFor(() => /3 rows/.test(text(document.body)) && /3 new/.test(text(document.body)), 'preview counts');
    byText('button', /^Import 3 new/).click();
    await waitFor(() => /Done/.test(text(document.body)), 'import result');
    const tx = await api('/api/transactions?q=BRAND%20NEW');
    expect(tx).to.have.length(2); // two identical rows on one day are both kept (multiset de-dup)
    // second upload: layout is remembered (no wizard) and nothing is new
    drop(app, 'chase2.csv', CHASE);
    await waitFor(() => /3 already imported/.test(text(document.body)), 'second preview');
    expect(/map the columns once/i.test(text(document.body))).to.equal(false);
    expect(byText('button', /^Import 0 new/)?.disabled ?? true).to.equal(true);
  });

  it('a new merchant lands in the inbox and the coverage table is fresh', async () => {
    const app = await mount('/imports');
    drop(app, 'chase.csv', CHASE);
    await waitFor(() => byText('button', /Save mapping/), 'wizard');
    byText('button', /Save mapping/).click();
    await waitFor(() => byText('button', /^Import 3 new/), 'import button');
    byText('button', /^Import 3 new/).click();
    await waitFor(() => /Done/.test(text(document.body)), 'done');
    const inbox = await api('/api/inbox');
    expect(inbox.needsCategory.some((t) => /BRAND NEW MERCHANT/.test(t.descriptor_raw))).to.equal(true);
    const cov = await api('/api/coverage');
    expect(cov.find((c) => c.institution === 'Chase').stale).to.equal(false);
  });
});

const WF = `"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"
"09/23/2026","PURCHASE                                AUTHORIZED ON   09/22 ORC*00YP28X REGION        888-988-6722  WA  S586266089684427   CARD 0414","-25.00","","Posted"
"09/17/2026","MONEY TRANSFER                          AUTHORIZED ON   09/16 CASH APP*CHRISTOPH        Oakland       CA  S306259641610654   CARD 0414","-20.00","","Posted"
"10/05/2026","ROCKET MORTGAGE  LOAN       261003 4288057         BRYS *SEPULVEDA","-4844.92","","Posted"
`;

describe('Imports: Wells Fargo has several accounts', () => {
  let trap;
  beforeEach(async () => { await reset(); trap = trapErrors(); });
  afterEach(() => { trap.stop(); expect(trap.errs).to.deep.equal([]); });

  it('each file must be assigned to an account, lands on it, and the merchants are cleaned (ORCA, CASH APP*…, ROCKET MORTGAGE LOAN)', async () => {
    const app = await mount('/imports');
    choose($('select', $('.card[style*="dashed"]')), 'Wells Fargo');
    drop(app, 'Checking_1.csv', WF);
    await waitFor(() => /map the columns once/i.test(text(document.body)) || $('.file-account'), 'file list');
    if (/map the columns once/i.test(text(document.body))) byText('button', /Save mapping/).click();
    const sel = await waitFor(() => $('.file-account'), 'account chooser');
    expect($$('option', sel).map((o) => text(o))).to.include.members(['Choose the account…', 'Wells Fargo Brys', 'Wells Fargo Miracle', 'Wells Fargo Home']);
    await waitFor(() => byText('button', /^Import/), 'import button');
    expect(byText('button', /^Import/).disabled, 'cannot import until an account is chosen').to.equal(true);
    choose(sel, 'Wells Fargo Home');
    await waitFor(() => !byText('button', /^Import/).disabled, 'enabled after choosing');
    byText('button', /^Import/).click();
    await waitFor(() => /Done/.test(text(document.body)), 'done');
    const accts = await api('/api/accounts'); const home = accts.find((a) => a.name === 'Wells Fargo Home').id;
    const tx = await api('/api/transactions?q=&limit=50');
    const mine = tx.filter((t) => t.account_id === home);
    expect(mine.map((t) => t.descriptor_clean).sort()).to.deep.equal(['CASH APP*CHRISTOPH', 'ORCA', 'ROCKET MORTGAGE LOAN']);
  });
});
