import { describe, it, expect } from 'vitest';
import { tipFromInput } from '../src/web/tip.js';

describe('tipFromInput: what you type in the tip box, in cents', () => {
  it('a percentage is of the charge before the tip, rounded to the cent', () => {
    expect(tipFromInput(2000, '20', 'pct')).toBe(400);
    expect(tipFromInput(1999, '18', 'pct')).toBe(360); // 359.82
    expect(tipFromInput(1000, '17.5%', 'pct')).toBe(175);
    expect(tipFromInput(1000, '0', 'pct')).toBe(0);
  });
  it('a dollar amount is taken as typed', () => {
    expect(tipFromInput(2000, '4', 'amt')).toBe(400);
    expect(tipFromInput(2000, '$4.25', 'amt')).toBe(425);
  });
  it('an empty box is no tip; nonsense, negatives and a percentage over 100 are rejected', () => {
    expect(tipFromInput(2000, '', 'pct')).toBe(0);
    expect(tipFromInput(2000, '  ', 'amt')).toBe(0);
    for (const bad of ['abc', '-5', '101']) expect(tipFromInput(2000, bad, 'pct')).toBeNull();
    expect(tipFromInput(2000, '-1', 'amt')).toBeNull();
  });
});
