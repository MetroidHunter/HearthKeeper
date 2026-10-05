# Cut-over runbook (design §18.5)

Everything below can be run locally with only your two spreadsheets. Real data lives in the gitignored `private/` folder.

## 1. Export the sheets
```
pip install openpyxl
python3 tools/xlsx_to_export.py private/BudgetProgram.xlsx private/export        # CSVs + parity oracle from the sheet's own cached cells
python3 tools/ifttt_to_messages.py private/IFTTTTransactions.xlsx private/export/ifttt_messages.jsonl
```
Export the xlsx on the day you freeze the sheets, with formulas calculated (Google Sheets: File > Download > .xlsx). The oracle is whatever the sheet showed when it was exported.

## 2. Migrate and prove parity
```
npm install
HK_DATA_DIR=./data npm run hk -- init --user "Brys:you@gmail.com" --user "Miracle:partner@gmail.com"   # accounts, ingest tokens (printed once), core rules
HK_DATA_DIR=./data npm run hk -- migrate --dir private/export --asof 2026-10-04 --merchants
```
Exit code 0 means P1-P7 are clean. Any mismatch is listed with the category and the difference; explanations can be added in code (`runParity(..., explanations)`).

## 3. Review what the import found
Start the server (`HK_AUTH=dev npm start`, or with Google sign-in), open **Migration**:
- the data-quality report (History rows the sheet silently ignores, categories that look retired, split groups that do not add up);
- the worksheet for `NEEDS CATEGORY` / blank leftovers: accept suggestions, apply, read the before/after balances. This is a separate audited edit; parity was proven first.

## 4. Seed rules and Greenlight
```
HK_DATA_DIR=./data npm run hk -- seed-rules --guesser docs/legacy-scripts/IFTTT_Guess.gs   # 236 rules in `suggest` mode, risky tokens as word matches
HK_DATA_DIR=./data npm run hk -- profiles                                                 # Miracle -> Miracle Spending, Marion -> Family Support
HK_DATA_DIR=./data npm run hk -- backtest-rules                                           # how the rules compare with all history
```

## 5. Backlog and live capture
- Upload the three-month backlog CSVs on **Imports** (map columns once per layout). Replay the IFTTT messages with `POST /ingest/device` or paste them in the Shapes page flow.
- Point the IFTTT webhook applet at `https://<host>/ingest/device?token=<greenlight-device secret>`; install `tools/receiver-apps-script.gs` in the receiver mailbox with the `receiver-mailbox` secret.
- Keep the Sheets applet running (dual-run) for a month; compare.

## 6. Deploy
`deploy/` has Caddy, systemd, the env file template, the nightly SQLite backup and a restore drill. Set `HK_AUTH=google`, `HK_GOOGLE_CLIENT_ID`, `HK_ALLOWED_EMAILS`, `HK_SESSION_SECRET`.

## 7. First close
Run one close in the app (**Close**), keep the sheets read-only for another month, then archive them and turn off the IFTTT Sheets applet.
