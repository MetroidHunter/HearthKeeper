/** Money is integer cents everywhere (design §6.4). */
export function parseCents(input: string | number): number {
  if (typeof input === 'number') return Math.round(input * 100);
  let s = input.trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`Bad money value: ${input}`);
  const [whole, frac = ''] = s.split('.');
  const cents = parseInt(whole || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return neg ? -cents : cents;
}

/** Whole cents only: legacy budgets and splits carry fractional cents (400/12), so a balance can be 4919.77 "cents". It is rounded, never printed as text. */
export function formatCents(c: number): string {
  const a = Math.round(Math.abs(c));
  const sign = c < 0 && a > 0 ? '-' : '';
  return `${sign}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * Legacy-faithful parse: keeps fractional cents (the sheet holds half-cent and 6-decimal split amounts, and monthly targets like 400/12).
 * Bank-sourced amounts are always whole cents; only the legacy import uses this. Result is in cents and may be fractional.
 */
export function parseCentsExact(input: string | number): number {
  const n = typeof input === 'number' ? input : Number(String(input).trim().replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  if (!Number.isFinite(n)) throw new Error(`Bad money value: ${input}`);
  return Number((n * 100).toFixed(6));
}
