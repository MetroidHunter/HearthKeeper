#!/usr/bin/env python3
"""Turn BudgetProgram.xlsx (with cached formula values) into the CSV set `npm run hk -- migrate` reads,
plus the parity oracle files captured from the sheet's own computed cells (design §18.1).

usage: python3 tools/xlsx_to_export.py private/BudgetProgram.xlsx private/export [--asof YYYY-MM-DD]
Needs: pip install openpyxl. Output stays in private/ (gitignored): it contains real financial data.
"""
import csv, sys, datetime, os, re
import openpyxl

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
wb = openpyxl.load_workbook(src, data_only=True)

def iso(d):
    return d.date().isoformat() if isinstance(d, datetime.datetime) else ('' if d is None else str(d))

def num(x):
    if x is None or x == '': return ''
    if isinstance(x, (int, float)): return repr(round(float(x), 9)).rstrip('0').rstrip('.') if '.' in repr(float(x)) else repr(float(x))
    return str(x)

def write(name, header, rows):
    with open(os.path.join(out, name), 'w', newline='') as f:
        w = csv.writer(f)
        if header: w.writerow(header)
        w.writerows(rows)

# --- source tabs ---
lst = [r for r in wb['List'].iter_rows(min_row=2, max_col=4, values_only=True) if r[0]]
write('List.csv', ['Name', 'Parent', 'Start Date', 'Deprecated'], [[r[0], r[1] or '', iso(r[2]), 'TRUE' if r[3] else ''] for r in lst])

hist = [r for r in wb['History'].iter_rows(min_row=2, max_col=3, values_only=True) if any(x is not None for x in r)]
write('History.csv', ['Budget Name', 'Budget', 'Month Stopped Using'], [[r[0] or '', num(r[1]), iso(r[2])] for r in hist])

bud = [r for r in wb['Budget'].iter_rows(min_row=5, max_col=4, values_only=True) if r[1]]
write('Budget.csv', ['Parent Budget', 'Budget Name', 'Budget', 'Current'], [[r[0] or '', r[1], num(r[2]), num(r[3])] for r in bud])

tx = [r for r in wb['Transactions'].iter_rows(min_row=2, max_col=6, values_only=True) if any(x is not None for x in r)]
write('Transactions.csv', ['Date', 'Name', 'Charge', 'Category', 'Split Total', 'Notes'],
      [[iso(r[0]), r[1] or '', num(r[2]), r[3] or '', num(r[4]), r[5] or ''] for r in tx])

# --- oracle: the sheet's own computed cells ---
it = wb['Internal']
def block(c0, c1, start=4):
    rows = []
    for r in it.iter_rows(min_row=start, min_col=c0, max_col=c1, values_only=True):
        if all(x is None for x in r): continue
        rows.append(list(r))
    return rows

ab = [[(r[0] if r[0] is not None else '(blank)'), num(r[1])] for r in block(1, 2) if r[1] is not None]
write('oracle_internal_AB.csv', None, ab)
hj = [[r[0], num(r[1]), r[2]] for r in block(8, 10) if r[0] and isinstance(r[1], (int, float))]
write('oracle_internal_HJ.csv', None, hj)
write('oracle_budget_current.csv', None, [[r[1], num(r[3]) if isinstance(r[3], (int, float)) else r[3]] for r in bud if r[3] is not None])

def kv(c0):  # category, total pairs
    return {r[0]: r[1] for r in block(c0, c0 + 1) if r[0] and isinstance(r[1], (int, float))}
st, gt, sl, gl = kv(13), kv(16), kv(19), kv(22)
cats = sorted(set(st) | set(gt) | set(sl) | set(gl))
# the sheet shows spent as a negative sum; the app's Spent is positive, so flip the sign here
# The cached Oct/Sep 2026 blocks are empty (no transactions since July), so also derive an independent P4 oracle for the last two
# months with data, re-implementing the sheet's QUERY: sum(C) by D where C<0 (or >0), name not matching [rR]eingest, date in month.
import collections, calendar
last = max(r[0] for r in tx if isinstance(r[0], datetime.datetime))
this_m = (last.year, last.month); prev_m = (this_m[0], this_m[1] - 1) if this_m[1] > 1 else (this_m[0] - 1, 12)
def month_sums(ym):
    neg, pos = collections.defaultdict(float), collections.defaultdict(float)
    for r in tx:
        if not isinstance(r[0], datetime.datetime) or (r[0].year, r[0].month) != ym or not isinstance(r[2], (int, float)): continue
        if re.search(r'[rR]eingest', r[1] or ''): continue
        (neg if r[2] < 0 else pos)[r[3] or ''] += r[2]
    return neg, pos
tn, tp = month_sums(this_m); pn, pp = month_sums(prev_m)
pcats = sorted(set(tn) | set(tp) | set(pn) | set(pp))
write('oracle_periods.csv', None, [[c, num(-tn.get(c, 0)), num(tp.get(c, 0)), num(-pn.get(c, 0)), num(pp.get(c, 0))] for c in pcats if c])
open(os.path.join(out, 'oracle_periods_month.txt'), 'w').write(f'{this_m[0]}-{this_m[1]:02d}')
_unused = ([[c, num(-st.get(c, 0)), num(gt.get(c, 0)), num(-sl.get(c, 0)), num(gl.get(c, 0))] for c in cats])
if False: write('oracle_periods.csv', None, [[c, num(-st.get(c, 0)), num(gt.get(c, 0)), num(-sl.get(c, 0)), num(gl.get(c, 0))] for c in cats])
b = wb['Budget']
open(os.path.join(out, 'oracle_allocated.txt'), 'w').write(num(b['C2'].value))
open(os.path.join(out, 'oracle_txn_count.txt'), 'w').write(str(len(tx)))
open(os.path.join(out, 'oracle_txn_total.txt'), 'w').write(num(sum(r[2] for r in tx if isinstance(r[2], (int, float)))))
m2 = it['M2'].value
print(f'{len(lst)} categories, {len(hist)} history rows, {len(bud)} budget rows, {len(tx)} transactions; sheet "this month" starts {iso(m2)}')
