/**
 * Matches external transaction notes (Amazon, Venmo, PayPal) into the
 * IFTTT transaction sheet's Notes column, by (date, amount).
 *
 * Expected IFTTT sheet column layout (A:G):
 *   A - Full Transaction (raw text)
 *   B - Date
 *   C - Description
 *   D - Amount
 *   E - Category        (already written by the existing convert()/_guessAtCategory script - untouched here)
 *   F - Split Total      (manual - untouched here)
 *   G - Notes            (written by this script)
 *
 * Expected source tabs (one per external source, each with header row Date,Amount,Note):
 *   AmazonNotes, VenmoNotes, PayPalNotes
 * Import each generated CSV as its own tab with these exact names, or edit
 * NOTES_SOURCE_SHEETS below to match whatever you actually name them.
 *
 * Run matchExternalNotes() with the IFTTT sheet active.
 */

const NOTES_SOURCE_SHEETS = ['AmazonNotes', 'VenmoNotes', 'PayPalNotes'];
const DATE_TOLERANCE_DAYS = 3; // allows for source-app-date vs bank-settlement-date drift
const AMOUNT_TOLERANCE = 0.005; // cents-level float slop only, not a real matching tolerance

function matchExternalNotes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const iftttSheet = SpreadsheetApp.getActiveSheet();

  const candidates = _loadCandidates(ss);
  if (candidates.length === 0) {
    Logger.log('No candidates loaded - check that the source tabs exist and are named correctly: ' + NOTES_SOURCE_SHEETS.join(', '));
    return;
  }

  const lastRow = iftttSheet.getLastRow();
  if (lastRow < 1) {
    Logger.log('IFTTT sheet appears empty.');
    return;
  }

  const range = iftttSheet.getRange(1, 1, lastRow, 7); // A:G
  const values = range.getValues();

  const rowsInfo = values.map((row, r) => {
    const existingNote = row[6]; // column G
    if (existingNote) return null; // never clobber an existing note - idempotent re-runs
    const rowDate = _coerceDate(row[1]); // column B
    const rowAmount = _coerceAmount(row[3]); // column D
    if (rowDate === null || rowAmount === null) return null;
    return { r, rowDate, rowAmount };
  });

  let matchedCount = 0;
  let ambiguousCount = 0;

  // Pass 1: EXACT date matches only. This must run to completion, across the
  // whole sheet, before any tolerance-window matching happens - otherwise a
  // coincidental near-date/same-amount row (e.g. a recurring transfer that
  // happens to land within the tolerance window of an unrelated transaction)
  // can steal a candidate from the row that's actually the true match.
  rowsInfo.forEach(info => {
    if (!info) return;
    const { r, rowDate, rowAmount } = info;
    const exact = candidates.filter(c =>
      !c.used &&
      Math.abs(c.amount - rowAmount) < AMOUNT_TOLERANCE &&
      Math.abs((c.date - rowDate) / 86400000) < 1 // same calendar day
    );
    if (exact.length === 1) {
      iftttSheet.getRange(r + 1, 7).setValue(exact[0].note);
      exact[0].used = true;
      matchedCount++;
      info.done = true;
    } else if (exact.length > 1) {
      const preview = exact.map(m => `${m.source}:"${m.note}"`).join(' | ');
      iftttSheet.getRange(r + 1, 7).setValue(`?? AMBIGUOUS (${exact.length} exact-date candidates) - ${preview}`);
      ambiguousCount++;
      info.done = true;
    }
  });

  // Pass 2: fallback to the tolerance window, only for rows still unmatched
  // and only against candidates not already consumed in pass 1.
  rowsInfo.forEach(info => {
    if (!info || info.done) return;
    const { r, rowDate, rowAmount } = info;
    const near = candidates.filter(c =>
      !c.used &&
      Math.abs(c.amount - rowAmount) < AMOUNT_TOLERANCE &&
      Math.abs((c.date - rowDate) / 86400000) <= DATE_TOLERANCE_DAYS
    );
    if (near.length === 1) {
      iftttSheet.getRange(r + 1, 7).setValue(near[0].note);
      near[0].used = true;
      matchedCount++;
    } else if (near.length > 1) {
      const preview = near.map(m => `${m.source}:"${m.note}"`).join(' | ');
      iftttSheet.getRange(r + 1, 7).setValue(`?? AMBIGUOUS (${near.length} nearby-date candidates) - ${preview}`);
      ambiguousCount++;
    }
    // no match at all -> leave blank, nothing to do
  });

  Logger.log(`Done. Matched: ${matchedCount}. Ambiguous (flagged): ${ambiguousCount}.`);
  SpreadsheetApp.getUi().alert(`Notes matching complete.\nMatched: ${matchedCount}\nFlagged as ambiguous: ${ambiguousCount}`);
}

function _loadCandidates(ss) {
  const candidates = [];
  NOTES_SOURCE_SHEETS.forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log('Source tab not found, skipping: ' + sheetName);
      return;
    }
    const data = sheet.getDataRange().getValues();
    // row 0 assumed header: Date, Amount, Note
    for (let i = 1; i < data.length; i++) {
      const date = _coerceDate(data[i][0]);
      const amount = _coerceAmount(data[i][1]);
      const note = data[i][2];
      if (date === null || amount === null || !note) continue;
      candidates.push({ date, amount, note: String(note), source: sheetName, used: false });
    }
  });
  return candidates;
}

function _coerceDate(val) {
  if (!val) return null;
  const d = (val instanceof Date) ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function _coerceAmount(val) {
  if (val === '' || val === null || val === undefined) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}