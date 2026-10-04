import { describe, it, expect } from 'vitest';
import { parseGreenlight } from '../src/greenlight/parse.js';

const S = ' on October 3, 2026 at 09:15PM';
describe('greenlight parsers (design §11.1 samples)', () => {
  const cases: [string, any][] = [
    ['Miracle spent $9.26 at TST* THE LUMBERYARD BA SEATTLE WA', { type: 'spend', profile: 'Miracle', amountCents: 926, vendor: 'TST* THE LUMBERYARD BA SEATTLE WA' }],
    ["Miracle's final purchase amount of $25.78 at El Rinconsito Seattle has posted.", { type: 'final_amount', profile: 'Miracle', amountCents: 2578, vendor: 'El Rinconsito Seattle' }],
    ['$50.00 allowance transferred to Miracle', { type: 'allowance', profile: 'Miracle', amountCents: 5000 }],
    ['$100.00 allowance transferred to Marion', { type: 'allowance', profile: 'Marion', amountCents: 10000 }],
    ["Miracle is scheduled to receive $50 allowance tomorrow morning. We'll send it unless you'd like to pause it.", { type: 'allowance_reminder', profile: 'Miracle', amountCents: 5000 }],
    ['↔️ Miracle moved $38.00 from Spend Anywhere to your Wallet. Tap to view details.', { type: 'return', profile: 'Miracle', amountCents: 3800 }],
    ["Marion's $33.79 purchase at WAL-MART #5393 GREENSBORO NC was declined due to insufficient funds in their GROCERY Spend Control. Tap.", { type: 'declined', profile: 'Marion', amountCents: 3379, control: 'GROCERY' }],
    ['Miracle received a $0.07 Greenlight Savings Reward!', { type: 'savings_reward', amountCents: 7 }],
    ["Marion's Greenlight card is on the way! 📫 Track it", { type: 'noise', reason: 'card_shipped' }],
    ['they can no longer use their debit card with payment apps', { type: 'noise', reason: 'restriction_notice' }],
    ['Something brand new happened', { type: 'unrecognized' }],
  ];
  for (const [text, want] of cases) {
    it(text.slice(0, 40), () => {
      const p = parseGreenlight(text + S);
      expect(p.event).toMatchObject(want);
      expect(p.pacificDate).toBe('2026-10-03');
      expect(p.occurredAtUtc).toBe('2026-10-04T04:15:00.000Z'); // PDT = UTC-7
    });
  }
  it('works without suffix (arrival time used by caller)', () => {
    const p = parseGreenlight('$50.00 allowance transferred to Marion');
    expect(p.occurredAtUtc).toBeNull();
    expect(p.event.type).toBe('allowance');
  });
});
