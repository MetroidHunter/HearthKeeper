#!/usr/bin/env python3
"""Dump column A of the IFTTTTransactions sheet (the raw notification text IFTTT captured) to one-message-per-line JSON, for corpus tests
and for replaying into /ingest. usage: python3 tools/ifttt_to_messages.py private/IFTTTTransactions.xlsx private/export/ifttt_messages.jsonl"""
import sys, json, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
n = 0
with open(sys.argv[2], 'w') as f:
    for (a,) in wb['Sheet1'].iter_rows(min_col=1, max_col=1, values_only=True):
        if a and a != 'Transactions':
            f.write(json.dumps(str(a), ensure_ascii=False) + '\n'); n += 1
print(n, 'messages')
