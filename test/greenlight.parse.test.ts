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
    ["Marion's $110.94 purchase at FOOD LION #2266 3501 N GREENSBORO NC was declined as they exceeded the number of incorrect PIN attempts.", { type: 'declined', profile: 'Marion', amountCents: 11094, reason: 'as they exceeded the number of incorrect PIN attempts' }],
    ["Marion's $141.17 purchase at FOOD LION #2266 GREENSBORO NC was declined due to insufficient funds on their card. Tap here to send them money.", { type: 'declined', profile: 'Marion', amountCents: 14117, reason: 'due to insufficient funds on their card' }],
    ["Marion's $26.06 purchase at WM SUPERCENTER #3658 GREENSBORO NC was declined.", { type: 'declined', profile: 'Marion', amountCents: 2606, vendor: 'WM SUPERCENTER #3658 GREENSBORO NC' }],
    ['Marion withdrew $23.00 from Fairway Food Mart Greensboro NC.', { type: 'withdraw', profile: 'Marion', amountCents: 2300, vendor: 'Fairway Food Mart Greensboro NC' }],
    ['Miracle withdrew $20.00 at SOME ATM', { type: 'withdraw', profile: 'Miracle', amountCents: 2000 }],
    ['Marion requests $50.00 to buy groceries', { type: 'request', profile: 'Marion', amountCents: 5000 }],
    ['Marion entered an incorrect PIN. Have them try again with the correct PIN. If needed, tap here to change their PIN.', { type: 'noise', reason: 'incorrect_pin' }],
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

import { existsSync, readFileSync } from 'node:fs';
const corpus = new URL('../private/export/ifttt_messages.jsonl', import.meta.url);
describe.skipIf(!existsSync(corpus))('real IFTTT corpus (private)', () => {
  it('every captured message parses to a known shape with a Pacific timestamp', () => {
    const msgs = readFileSync(corpus, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string);
    const bad = msgs.map(parseGreenlight).filter((p) => p.event.type === 'unrecognized' || !p.pacificDate);
    expect(bad.map((b) => b.body)).toEqual([]);
    expect(msgs.length).toBeGreaterThan(100);
  });
});
