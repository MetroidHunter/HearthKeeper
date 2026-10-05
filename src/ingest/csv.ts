import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { parseCents } from '../core/money.js';

/** Minimal RFC 4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c !== '')) rows.push(row); }
  return rows;
}

export type ColRef = string | number;
export interface ColumnMap { date: ColRef; amount?: ColRef; debit?: ColRef; credit?: ColRef; description: ColRef; postDate?: ColRef; category?: ColRef; note?: ColRef; hasHeader: boolean }
export interface ProfileSpec { columnMap: ColumnMap; dateFormat: string; signRule: 'as_is' | 'invert'; skipRows: number }

/** Header signature keys a saved profile to a file layout (design §8.3). */
export function headerSignature(rows: string[][], skipRows = 0): string {
  const first = rows[skipRows] ?? [];
  return createHash('sha1').update(first.map((c) => c.trim().toLowerCase()).join('|')).digest('hex').slice(0, 16);
}
export function layoutSignature(rows: string[][], hasHeader: boolean, skipRows = 0): string {
  if (hasHeader) return headerSignature(rows, skipRows);
  const n = (rows[skipRows] ?? []).length;
  return createHash('sha1').update(`headerless:${n}`).digest('hex').slice(0, 16);
}

export interface ParsedRow { date: string; postedOn?: string; amountCents: number; description: string; note?: string; category?: string; line: number }
export interface RowError { line: number; error: string }

function pick(row: string[], header: string[] | null, ref: ColRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'number') return row[ref];
  const i = header?.findIndex((h) => h.trim().toLowerCase() === ref.trim().toLowerCase()) ?? -1;
  return i >= 0 ? row[i] : undefined;
}
function parseDate(v: string, fmt: string): string {
  const d = DateTime.fromFormat(v.trim(), fmt, { zone: 'utc' });
  if (!d.isValid) throw new Error(`bad date "${v}" for format ${fmt}`);
  return d.toISODate()!;
}

export function applyProfile(rows: string[][], spec: ProfileSpec): { rows: ParsedRow[]; errors: RowError[] } {
  const start = spec.skipRows;
  const header = spec.columnMap.hasHeader ? rows[start] : null;
  const body = rows.slice(start + (spec.columnMap.hasHeader ? 1 : 0));
  const out: ParsedRow[] = [], errors: RowError[] = [];
  body.forEach((r, i) => {
    const line = start + (spec.columnMap.hasHeader ? 2 : 1) + i;
    try {
      const m = spec.columnMap;
      const d = pick(r, header, m.date);
      if (!d) throw new Error('missing date');
      let cents: number;
      if (m.amount !== undefined) {
        const a = pick(r, header, m.amount);
        if (a === undefined || a.trim() === '') throw new Error('missing amount');
        cents = parseCents(a);
      } else {
        const db = (pick(r, header, m.debit) ?? '').trim(), cr = (pick(r, header, m.credit) ?? '').trim();
        cents = (cr ? parseCents(cr) : 0) - (db ? Math.abs(parseCents(db)) : 0);
      }
      if (spec.signRule === 'invert') cents = -cents;
      const desc = (pick(r, header, m.description) ?? '').trim();
      const pd = pick(r, header, m.postDate);
      out.push({ date: parseDate(d, spec.dateFormat), postedOn: pd ? parseDate(pd, spec.dateFormat) : undefined, amountCents: cents, description: desc, note: pick(r, header, m.note), category: pick(r, header, m.category), line });
    } catch (e) { errors.push({ line, error: (e as Error).message }); }
  });
  return { rows: out, errors };
}

export function normalizeDescriptor(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(); }
export function rowFingerprint(institution: string, date: string, cents: number, description: string): string {
  return `${institution}|${date}|${cents}|${normalizeDescriptor(description)}`;
}

/** Heuristic starting point for the mapping wizard: suggest columns from header names / content. */
export function suggestMapping(rows: string[][]): { columnMap: ColumnMap; dateFormat: string; signRule: 'as_is' | 'invert' } {
  const first = rows[0] ?? [];
  // a header row has words but no dates and no money amounts; a data row has at least one of those
  const isDate = (c: string) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c.trim()) || /^\d{4}-\d{2}-\d{2}$/.test(c.trim());
  const isMoney = (c: string) => /^-?[$(]?[\d,]+\.\d{2}\)?$/.test(c.trim());
  const looksHeader = first.some((c) => /[A-Za-z]{3,}/.test(c)) && !first.some((c) => isDate(c) || isMoney(c));
  const names = first.map((c) => c.trim().toLowerCase());
  const find = (...re: RegExp[]) => { const i = names.findIndex((n) => re.some((r) => r.test(n))); return i >= 0 ? (looksHeader ? first[i] : i) : undefined; };
  const sample = rows[looksHeader ? 1 : 0] ?? [];
  const dateIdx = sample.findIndex((c) => /^\d{1,2}\/\d{1,2}\/\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(c.trim()));
  const dateStr = sample[dateIdx] ?? '';
  const dateFormat = /^\d{4}-/.test(dateStr) ? 'yyyy-MM-dd' : /\/\d{4}$/.test(dateStr) ? 'M/d/yyyy' : 'M/d/yy';
  if (looksHeader) {
    return { dateFormat, signRule: 'as_is', columnMap: { hasHeader: true, date: find(/^(transaction )?date$/, /trans.*date/) ?? first[0], postDate: find(/post/), amount: find(/^amount$/), debit: find(/debit/), credit: find(/credit/), description: find(/desc/, /payee/, /name/, /merchant/) ?? first[1], category: find(/^category$/), note: find(/memo|note/) } };
  }
  const amtIdx = sample.findIndex((c, i) => i !== dateIdx && /^-?[$(]?[\d,]+\.\d{2}\)?$/.test(c.trim()));
  const descIdx = sample.reduce((best, c, i) => (i !== dateIdx && i !== amtIdx && c.length > (best < 0 ? -1 : sample[best].length) ? i : best), -1); // best starts at -1: it must never default to the date column
  return { dateFormat, signRule: 'as_is', columnMap: { hasHeader: false, date: Math.max(dateIdx, 0), amount: Math.max(amtIdx, 0), description: descIdx } };
}
