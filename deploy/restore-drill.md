# Restore drill (before cut-over, then quarterly)
1. `gsutil cp $HK_BACKUP_BUCKET/<latest>.sqlite.gz . && gunzip <latest>.sqlite.gz`
2. On a scratch VM: `HK_DATA_DIR=./restore HK_AUTH=dev npm start` with the file renamed to `restore/hearthkeeper.sqlite`
3. Open the Dashboard: the invariants list must be empty and the Budget page balances must match production.
