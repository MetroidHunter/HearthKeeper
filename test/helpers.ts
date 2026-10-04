import { openDb, type DB } from '../src/core/db.js';
import { addCategory } from '../src/core/categories.js';

export function seedHousehold(db: DB = openDb()) {
  const acc = (name: string, inst: string, type: string, extra = '') =>
    Number(db.prepare(`INSERT INTO accounts(name,institution,type${extra ? ',shared' : ''}) VALUES (?,?,?${extra ? ',1' : ''})`).run(name, inst, type).lastInsertRowid);
  const chase = acc('Chase Prime Visa', 'Chase', 'credit_card', 's');
  const wf = acc('Wells Fargo', 'Wells Fargo', 'bank');
  const wallet = acc('Greenlight wallet', 'Greenlight', 'greenlight_wallet', 's');
  const cats: Record<string, number> = {};
  for (const [name, group, monthly, kind] of [
    ['Miracle Spending', 'Family', 5000, 'expense'], ['Family Support', 'Family', 40000, 'expense'], ['Eating Out', 'Food', 30000, 'expense'],
    ['Groceries', 'Food', 80000, 'expense'], ['Manicure', 'Personal', 12500, 'expense'], ['Fees and Taxes', 'Misc', 1000, 'expense'],
    ['Gig Income', 'Income', 0, 'income_pool'], ['Salary', 'Income', 0, 'income_reference'],
  ] as const) cats[name] = addCategory(db, { name, group, startMonth: '2026-01', monthlyCents: monthly, kind });
  const profile = (display: string, pat: string, cat: string, spend: string, req: string) =>
    Number(db.prepare('INSERT INTO greenlight_profiles(display_name,name_pattern,category_id,wallet_account_id,spend_policy,request_policy) VALUES (?,?,?,?,?,?)').run(display, pat, cats[cat], wallet, spend, req).lastInsertRowid);
  const miracle = profile('Miracle', '^miracle$', 'Miracle Spending', 'reclassify', 'as_allowance');
  const marion = profile('Marion', '^marion$', 'Family Support', 'ignore', 'ask_category');
  return { db, chase, wf, wallet, cats, miracle, marion };
}
