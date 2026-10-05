#!/usr/bin/env bash
# Run on your computer. Rebuilds the production database from your spreadsheets, proves parity, and writes a snapshot.
# Repeatable: it always starts from an empty directory, so the result depends only on the xlsx files and the code.
#
#   HK_USERS="Brys:you@gmail.com;Miracle:partner@gmail.com" bash deploy/build-prod-db.sh [BudgetProgram.xlsx] [IFTTTTransactions.xlsx]
#   ASOF=2026-10-04 overrides the as-of date (default: today, Pacific)
# Exit status is non-zero if parity fails. Nothing is uploaded; follow with deploy/push-data.sh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${HK_USERS:?set HK_USERS=\"Name:email;Name:email\"}"
BUDGET=${1:-private/BudgetProgram.xlsx}; IFTTT=${2:-private/IFTTTTransactions.xlsx}
ASOF=${ASOF:-$(TZ=America/Los_Angeles date +%F)}
OUT=private/prod; EXPORT=$OUT/export; DATA=$OUT/data; SNAP=private/snapshots
[ -f "$BUDGET" ] || { echo "missing $BUDGET"; exit 1; }
rm -rf "$OUT"; mkdir -p "$EXPORT" "$SNAP"
HK() { HK_DATA_DIR="$DATA" npm run --silent hk -- "$@"; }

echo "==> 1/6 export sheets (cached cell values are the parity oracle; export the xlsx with formulas calculated)"
python3 tools/xlsx_to_export.py "$BUDGET" "$EXPORT" > "$OUT/export.log"
[ -f "$IFTTT" ] && python3 tools/ifttt_to_messages.py "$IFTTT" "$EXPORT/ifttt_messages.jsonl" >> "$OUT/export.log" || echo "   (no IFTTT workbook; skipping message corpus)"
echo "==> 2/6 init household"
ARGS=(); IFS=';' read -ra U <<< "$HK_USERS"; for u in "${U[@]}"; do ARGS+=(--user "$u"); done
HK init "${ARGS[@]}" > "$OUT/init.json"
echo "==> 3/6 import + parity as of $ASOF"
HK migrate --dir "$EXPORT" --asof "$ASOF" --merchants | tee "$OUT/migrate.log" | tail -n 25   # exits non-zero on any parity mismatch
echo "==> 4/6 rules and Greenlight profiles"
HK seed-rules --guesser docs/legacy-scripts/IFTTT_Guess.gs > "$OUT/seed-rules.log"
HK profiles | tee "$OUT/profiles.log"
echo "==> 5/6 snapshot"
HK snapshot --out "$SNAP" --name "hk-prod-$(date -u +%Y%m%dT%H%M%SZ)" | tee "$OUT/snapshot.log"
GZ=$(ls -1t "$SNAP"/hk-prod-*.sqlite.gz | head -1)
echo "==> 6/6 verify the snapshot"
npm run --silent hk -- verify --file "$GZ"
echo; echo "Ready: $GZ"
echo "Next: HK_VM=<vm> HK_ZONE=<zone> bash deploy/push-data.sh $GZ"
