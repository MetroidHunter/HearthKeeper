import { DateTime } from 'luxon';

export const HOME_ZONE = 'America/Los_Angeles';
export const CHASE_ZONE = 'America/New_York';

/** 'YYYY-MM' month key from a local date string. */
export function monthOf(date: string): string { return date.slice(0, 7); }

export function monthIndex(m: string): number {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + (mo - 1);
}
export function monthFromIndex(i: number): string {
  const y = Math.floor(i / 12);
  return `${y}-${String((i % 12) + 1).padStart(2, '0')}`;
}
/** Inclusive count of months from a through b (0 if b < a). */
export function monthsInclusive(a: string, b: string): number {
  return Math.max(0, monthIndex(b) - monthIndex(a) + 1);
}
export function addMonths(m: string, n: number): string { return monthFromIndex(monthIndex(m) + n); }

/** Convert a wall-clock time in `zone` at its own date (DST-correct) to a UTC ISO string and the Pacific local date. */
export function localToUtc(isoLocal: string, zone: string): { utc: string; pacificDate: string } {
  const dt = DateTime.fromISO(isoLocal, { zone });
  if (!dt.isValid) throw new Error(`Bad datetime: ${isoLocal} (${dt.invalidExplanation})`);
  return { utc: dt.toUTC().toISO()!, pacificDate: dt.setZone(HOME_ZONE).toISODate()! };
}

export function pacificDateOfUtc(utc: string): string {
  return DateTime.fromISO(utc, { zone: 'utc' }).setZone(HOME_ZONE).toISODate()!;
}

export function daysBetween(a: string, b: string): number {
  return Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days);
}
