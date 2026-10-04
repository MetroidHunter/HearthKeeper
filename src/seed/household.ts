import type { DB } from '../core/db.js';
import { createToken } from '../ingest/events.js';
import { createScenario } from '../core/earnings.js';

/**
 * First-run seed: accounts and Greenlight profiles from the design's answers (§7.1, §11.3, D7, D35).
 * Categories are NOT seeded here: they come from the legacy import (`npm run migrate`) or are added in the UI.
 * Idempotent; returns freshly generated ingest-token secrets once (store them in the capture tools).
 */
export function seedHousehold(db: DB, opts: { users?: { name: string; email: string }[] } = {}) {
  const out: { tokens: Record<string, string> } = { tokens: {} };
  db.transaction(() => {
    for (const u of opts.users ?? []) db.prepare('INSERT OR IGNORE INTO users(name,email) VALUES (?,?)').run(u.name, u.email);
    const acc = (name: string, inst: string, type: string, shared = 0) => db.prepare('INSERT OR IGNORE INTO accounts(name,institution,type,shared) VALUES (?,?,?,?)').run(name, inst, type, shared);
    acc('Chase Prime Visa', 'Chase', 'credit_card', 1);
    for (const n of ['Brys', 'Miracle', 'Home']) acc(`Wells Fargo ${n}`, 'Wells Fargo', 'bank');
    acc('Greenlight wallet', 'Greenlight', 'greenlight_wallet', 1);
    for (const n of ['Brys', 'Miracle']) { acc(`Venmo ${n}`, 'Venmo', 'venmo'); acc(`PayPal ${n}`, 'PayPal', 'paypal'); }
    acc('Amazon', 'Amazon', 'amazon', 1);
    if (!db.prepare("SELECT 1 FROM ingest_tokens WHERE label='greenlight-device'").get()) out.tokens['greenlight-device'] = createToken(db, 'greenlight-device', 'device', 72).secret;
    if (!db.prepare("SELECT 1 FROM ingest_tokens WHERE label='receiver-mailbox'").get()) out.tokens['receiver-mailbox'] = createToken(db, 'receiver-mailbox', 'email', 72).secret;
  })();
  return out;
}

/** Greenlight profiles need categories to exist first (D7: Miracle -> Miracle Spending, Marion -> Family Support). */
export function seedGreenlightProfiles(db: DB): string[] {
  const wallet = db.prepare("SELECT id FROM accounts WHERE type='greenlight_wallet'").get() as { id: number } | undefined;
  if (!wallet) throw new Error('seedHousehold first');
  const missing: string[] = [];
  for (const [display, pattern, cat, spend, req] of [['Miracle', '^miracle$', 'Miracle Spending', 'reclassify', 'as_allowance'], ['Marion', '^marion$', 'Family Support', 'ignore', 'ask_category']] as const) {
    const c = db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(cat) as { id: number } | undefined;
    if (!c) { missing.push(cat); continue; }
    db.prepare('INSERT OR IGNORE INTO greenlight_profiles(display_name,name_pattern,category_id,wallet_account_id,spend_policy,request_policy) VALUES (?,?,?,?,?,?)').run(display, pattern, c.id, wallet.id, spend, req);
  }
  return missing;
}

/** Default rules the design calls for regardless of the legacy guesser: Greenlight funding/fees, card-payment legs (§8.8, §11.2, §21.1). */
export function seedCoreRules(db: DB) {
  const has = (note: string) => db.prepare('SELECT 1 FROM rules WHERE notes=?').get(note);
  const add = (note: string, priority: number, all_of: any[], action: any, mode: string) => { if (!has(note)) db.prepare('INSERT INTO rules(priority,match_json,action_json,mode,origin,notes) VALUES (?,?,?,?,?,?)').run(priority, JSON.stringify({ all_of }), JSON.stringify(action), mode, 'user', note); };
  const d = (v: string) => ({ field: 'descriptor', op: 'contains', value: v });
  add('core: greenlight plan fee', 40, [d('greenlight app'), { field: 'amount_cents', op: 'eq', value: -662 }], { type: 'categorize', category: 'Fees and Taxes' }, 'suggest');
  add('core: greenlight funding', 50, [d('greenlight app')], { type: 'internal_transfer', reason: 'greenlight_funding' }, 'auto');
  add('core: card payment (wf leg)', 50, [d('chase credit crd')], { type: 'internal_transfer', reason: 'card_payment' }, 'auto');
  add('core: card payment (chase leg)', 50, [d('payment thank you')], { type: 'internal_transfer', reason: 'card_payment' }, 'auto');
  add('core: chase card serv', 50, [d('chase card serv')], { type: 'internal_transfer', reason: 'card_payment' }, 'auto');
}
export { createScenario };
