/**
 * What you typed in a tip box, in whole cents. `baseCents` is the charge before the tip (a positive number). A percentage is of that charge, rounded to the
 * cent and capped at 100%; a dollar amount is taken as typed. An empty box means no tip. Returns null for anything that is not a sensible tip.
 */
export function tipFromInput(baseCents: number, value: string, unit: 'pct' | 'amt'): number | null {
  const v = value.replace(/[$,%\s]/g, '');
  if (v === '') return 0;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(v)) return null;
  const n = parseFloat(v);
  if (unit === 'pct') return n > 100 ? null : Math.round((baseCents * n) / 100);
  return Math.round(n * 100);
}
