/** SQLite schema (design §7). Migrations are append-only; each entry runs once. */
export const MIGRATIONS: string[] = [
`
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, notify_prefs_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, institution TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('credit_card','bank','greenlight_wallet','venmo','paypal','amazon','cash')),
  owner_user_id INTEGER REFERENCES users(id), shared INTEGER NOT NULL DEFAULT 0, in_system INTEGER NOT NULL DEFAULT 1,
  last4 TEXT, sync_method TEXT, last_synced_at TEXT, import_profile_id INTEGER);
CREATE TABLE category_groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE categories(id INTEGER PRIMARY KEY, group_id INTEGER REFERENCES category_groups(id), name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK(kind IN ('expense','income_pool','income_reference')),
  discretionary INTEGER NOT NULL DEFAULT 1, cushion_cents INTEGER, overage_priority INTEGER,
  start_month TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  retired_month TEXT, sort INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE favorites(user_id INTEGER NOT NULL REFERENCES users(id), category_id INTEGER NOT NULL REFERENCES categories(id), sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, category_id));

CREATE TABLE earning_scenarios(id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT, archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE earning_scenario_lines(id INTEGER PRIMARY KEY, scenario_id INTEGER NOT NULL REFERENCES earning_scenarios(id) ON DELETE CASCADE,
  person TEXT, label TEXT NOT NULL, annual_salary_cents INTEGER NOT NULL, work_time_bp INTEGER NOT NULL DEFAULT 10000,
  tax_rate_bp INTEGER NOT NULL, recurring INTEGER NOT NULL DEFAULT 1);
CREATE TABLE budget_plans(id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','live','archived')),
  scenario_id INTEGER REFERENCES earning_scenarios(id), income_snapshot_cents INTEGER, base_note TEXT, created_from_live_plan_id INTEGER,
  made_live_at TEXT, made_live_by TEXT, effective_month TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE budget_plan_items(plan_id INTEGER NOT NULL REFERENCES budget_plans(id) ON DELETE CASCADE, category_id INTEGER NOT NULL REFERENCES categories(id), monthly_cents INTEGER NOT NULL, note TEXT, PRIMARY KEY(plan_id, category_id));
CREATE TABLE category_budget_versions(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), monthly_cents INTEGER NOT NULL,
  effective_month TEXT NOT NULL, plan_id INTEGER REFERENCES budget_plans(id), reason TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(category_id, effective_month));

CREATE TABLE ingest_tokens(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, user_id INTEGER, channel TEXT NOT NULL, secret TEXT NOT NULL, last_seen_at TEXT, expected_cadence_hours INTEGER);
CREATE TABLE raw_events(id INTEGER PRIMARY KEY, source TEXT NOT NULL, channel TEXT NOT NULL, received_at TEXT NOT NULL, ingest_token_id INTEGER REFERENCES ingest_tokens(id),
  payload TEXT NOT NULL, headers_json TEXT, dedupe_key TEXT NOT NULL UNIQUE, parser_version TEXT, parse_status TEXT NOT NULL DEFAULT 'pending' CHECK(parse_status IN ('pending','ok','noise','unrecognized','error','llm_proposed')),
  error TEXT, fingerprint TEXT);
CREATE INDEX raw_events_status ON raw_events(parse_status);
CREATE INDEX raw_events_fp ON raw_events(fingerprint);
CREATE TABLE import_profiles(id INTEGER PRIMARY KEY, name TEXT NOT NULL, institution TEXT NOT NULL, header_signature TEXT NOT NULL UNIQUE, column_map_json TEXT NOT NULL, date_format TEXT NOT NULL, sign_rule TEXT NOT NULL, skip_rows INTEGER NOT NULL DEFAULT 0);

CREATE TABLE merchants(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, review_state TEXT NOT NULL DEFAULT 'unreviewed', default_category_id INTEGER REFERENCES categories(id), default_mode TEXT NOT NULL DEFAULT 'suggest');
CREATE TABLE merchant_aliases(id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), match_type TEXT NOT NULL, pattern TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100);
CREATE TABLE merchant_groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE merchant_group_members(group_id INTEGER NOT NULL REFERENCES merchant_groups(id), merchant_id INTEGER NOT NULL REFERENCES merchants(id), PRIMARY KEY(group_id, merchant_id));
CREATE TABLE rules(id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 100, match_json TEXT NOT NULL, action_json TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'suggest', origin TEXT NOT NULL DEFAULT 'user', hit_count INTEGER NOT NULL DEFAULT 0, clean_confirmations INTEGER NOT NULL DEFAULT 0,
  override_count INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT, notes TEXT);

CREATE TABLE transactions(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), owner_user_id INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('spending','income','internal_transfer','greenlight_allowance','greenlight_return','greenlight_reclass','ignored')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('provisional','posted','stale','void')),
  occurred_on TEXT NOT NULL, posted_on TEXT, authorized_at TEXT, amount_cents INTEGER NOT NULL,
  descriptor_raw TEXT NOT NULL DEFAULT '', descriptor_clean TEXT, merchant_id INTEGER REFERENCES merchants(id), location_hint TEXT,
  review_state TEXT NOT NULL DEFAULT 'needs_category' CHECK(review_state IN ('auto_categorized','needs_category','user_confirmed','not_needed')),
  decided_by TEXT, decided_rule_id INTEGER, note TEXT,
  note_state TEXT NOT NULL DEFAULT 'not_needed' CHECK(note_state IN ('not_needed','auto_matched','awaiting_note','ambiguous','needs_note','user_provided')),
  note_source TEXT, flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT, ignored_reason TEXT, superseded_by INTEGER, transfer_group INTEGER,
  legacy_group TEXT, source_event_ids TEXT NOT NULL DEFAULT '[]', fingerprint TEXT, greenlight_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX txn_date ON transactions(occurred_on);
CREATE INDEX txn_fp ON transactions(fingerprint);
CREATE TABLE transaction_splits(id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, category_id INTEGER REFERENCES categories(id),
  amount_cents INTEGER NOT NULL, memo TEXT, origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','rule','item','greenlight_reclass','legacy')));
CREATE INDEX split_cat ON transaction_splits(category_id);
CREATE TABLE external_notes(id INTEGER PRIMARY KEY, source TEXT NOT NULL, account_id INTEGER, occurred_on TEXT NOT NULL, amount_cents INTEGER NOT NULL, note TEXT NOT NULL,
  counterparty TEXT, order_ref TEXT, shared_note INTEGER NOT NULL DEFAULT 0, raw_event_id INTEGER, matched_txn_id INTEGER);
CREATE TABLE external_note_items(id INTEGER PRIMARY KEY, external_note_id INTEGER NOT NULL REFERENCES external_notes(id) ON DELETE CASCADE, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, amount_cents INTEGER NOT NULL, category_suggestion_id INTEGER);

CREATE TABLE envelope_transfers(id INTEGER PRIMARY KEY, occurred_on TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reconcile','pool_payment','placement','manual','adjustment','legacy')), memo TEXT, created_by TEXT, legacy_name TEXT);
CREATE TABLE envelope_transfer_legs(id INTEGER PRIMARY KEY, transfer_id INTEGER NOT NULL REFERENCES envelope_transfers(id) ON DELETE CASCADE, category_id INTEGER NOT NULL REFERENCES categories(id), amount_cents INTEGER NOT NULL);
CREATE INDEX leg_cat ON envelope_transfer_legs(category_id);

CREATE TABLE greenlight_profiles(id INTEGER PRIMARY KEY, display_name TEXT NOT NULL UNIQUE, name_pattern TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id), wallet_account_id INTEGER REFERENCES accounts(id),
  spend_policy TEXT NOT NULL CHECK(spend_policy IN ('ignore','reclassify')), request_policy TEXT NOT NULL CHECK(request_policy IN ('as_allowance','ask_category')),
  withdraw_policy TEXT NOT NULL DEFAULT 'ask' CHECK(withdraw_policy IN ('ask','debit_category','ignore')), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE greenlight_requests(id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, requested_at TEXT NOT NULL, raw_event_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','funded','declined','stale')), funded_txn_id INTEGER, chosen_category_id INTEGER);
CREATE TABLE greenlight_expected_allowances(id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, expected_on TEXT NOT NULL, raw_event_id INTEGER, fulfilled_txn_id INTEGER);

CREATE TABLE close_periods(id INTEGER PRIMARY KEY, through_date TEXT NOT NULL, closed_by TEXT, closed_at TEXT NOT NULL DEFAULT (datetime('now')), snapshot_json TEXT);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL, before_json TEXT, after_json TEXT, actor TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE notification_log(id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT NOT NULL, ref_id INTEGER, sent_at TEXT NOT NULL DEFAULT (datetime('now')), answered_at TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
`
CREATE TABLE greenlight_processed(raw_event_id INTEGER PRIMARY KEY, outcome TEXT NOT NULL, txn_id INTEGER, detail_json TEXT);
`,
`
CREATE TABLE shape_decisions(fingerprint TEXT NOT NULL, source TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('parser','noise','needs_look')), decided_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(fingerprint, source));
CREATE TABLE ingest_nonces(token_id INTEGER NOT NULL, nonce TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(token_id, nonce));
`,
`
CREATE TABLE event_results(raw_event_id INTEGER NOT NULL, parser TEXT NOT NULL, outcome TEXT NOT NULL, txn_id INTEGER, PRIMARY KEY(raw_event_id, parser));
`,
`
CREATE TABLE push_subscriptions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_ok_at TEXT);
ALTER TABLE notification_log ADD COLUMN tag TEXT;
ALTER TABLE notification_log ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
CREATE INDEX notification_log_tag ON notification_log(tag);
`,
`
CREATE INDEX split_txn ON transaction_splits(transaction_id);
CREATE INDEX txn_review ON transactions(review_state, status);
CREATE INDEX txn_account_date ON transactions(account_id, occurred_on);
CREATE INDEX txn_note_state ON transactions(note_state);
CREATE INDEX txn_merchant ON transactions(merchant_id);
`,
`
ALTER TABLE categories ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
`,
`
-- the HTML part of an email, kept next to its plain text: Venmo/PayPal/Amazon only parse reliably from it
ALTER TABLE raw_events ADD COLUMN html TEXT;
`,
`
-- Merchant rules are no longer stored: a merchant's usual category is whatever you chose for it most often (see core/merchants.ts) and it only ever suggests.
-- Anything you had set to "auto" was a real decision, so it becomes an ordinary rule of yours. Learned suggest-mode rules are dropped (the history says the same).
INSERT INTO rules(priority, match_json, action_json, mode, origin, notes)
  SELECT 100, json_object('all_of', json_array(json_object('field','merchant','op','eq','value',m.name))), json_object('type','categorize','category',c.name), 'auto', 'user', 'was the automatic category for ' || m.name
  FROM merchants m JOIN categories c ON c.id=m.default_category_id WHERE m.default_mode='auto';
UPDATE rules SET origin='user' WHERE origin='learned' AND mode='auto';
UPDATE transactions SET decided_rule_id=NULL WHERE decided_rule_id IN (SELECT id FROM rules WHERE origin='learned');
DELETE FROM rules WHERE origin='learned';
`,
`
-- which history row (from the old sheet) a bank-file row was recognised as: keeps the importer, a re-import and the clean-up in agreement
CREATE TABLE history_claims(legacy_id INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(legacy_id, fingerprint));
`,
`
-- short, dismissable heads-ups shown on Home (no action needed), e.g. "Groceries went over budget after an automatic categorization"
CREATE TABLE notices(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, category_id INTEGER, txn_id INTEGER, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), dismissed_at TEXT);
CREATE INDEX notices_open ON notices(dismissed_at);
`,
`
-- weekly budgets: a monthly amount spread over the weeks of each month (weeks are cut at month ends), counting spending in the chosen categories
CREATE TABLE weekly_budgets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), week_start INTEGER NOT NULL DEFAULT 1 CHECK(week_start BETWEEN 1 AND 7),
  rollover INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE weekly_budget_categories(weekly_id INTEGER NOT NULL REFERENCES weekly_budgets(id) ON DELETE CASCADE, category_id INTEGER NOT NULL REFERENCES categories(id), PRIMARY KEY(weekly_id, category_id));
CREATE TABLE weekly_favorites(user_id INTEGER NOT NULL REFERENCES users(id), weekly_id INTEGER NOT NULL REFERENCES weekly_budgets(id) ON DELETE CASCADE, PRIMARY KEY(user_id, weekly_id));
`,
`
-- a weekly budget is now powered by ONE category and uses that category's monthly budget as its total (its name is "<category> Weekly"); rebuilt to drop the typed name and amount
CREATE TABLE wb_old AS SELECT b.id, b.sort, b.week_start, b.created_at, (SELECT MIN(category_id) FROM weekly_budget_categories c WHERE c.weekly_id=b.id) category_id FROM weekly_budgets b;
CREATE TABLE wf_old AS SELECT user_id, weekly_id FROM weekly_favorites;
DROP TABLE weekly_favorites;
DROP TABLE weekly_budget_categories;
DROP TABLE weekly_budgets;
CREATE TABLE weekly_budgets(id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id), week_start INTEGER NOT NULL DEFAULT 1 CHECK(week_start BETWEEN 1 AND 7),
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
INSERT OR IGNORE INTO weekly_budgets(id, category_id, week_start, sort, created_at) SELECT id, category_id, week_start, sort, created_at FROM wb_old WHERE category_id IS NOT NULL ORDER BY id;
CREATE TABLE weekly_favorites(user_id INTEGER NOT NULL REFERENCES users(id), weekly_id INTEGER NOT NULL REFERENCES weekly_budgets(id) ON DELETE CASCADE, PRIMARY KEY(user_id, weekly_id));
INSERT INTO weekly_favorites(user_id, weekly_id) SELECT user_id, weekly_id FROM wf_old WHERE weekly_id IN (SELECT id FROM weekly_budgets);
DROP TABLE wb_old;
DROP TABLE wf_old;
`,
];
