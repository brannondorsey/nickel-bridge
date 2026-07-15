import { describe, expect, it } from 'vitest';
import { Card, Deal, PASS, RANK_CHARS, makeBid, makeCard } from '@bridge/core';
import { Bidder, gradeFromProbs } from '../src/bidder.js';
import { loadPolicyModel } from '../src/model.js';

const b = makeBid;

describe('gradeFromProbs', () => {
  it('grades by probability ratio with the documented thresholds', () => {
    expect(gradeFromProbs(0.5, 0.5, true)).toEqual({ grade: 'excellent', score: 1 });
    expect(gradeFromProbs(0.3, 0.5, false).grade).toBe('excellent'); // ratio 0.6
    expect(gradeFromProbs(0.1, 0.5, false).grade).toBe('good'); // ratio 0.2
    expect(gradeFromProbs(0.025, 0.5, false).grade).toBe('fair'); // ratio 0.05
    expect(gradeFromProbs(0.01, 0.5, false)).toEqual({ grade: 'poor', score: 0 });
    expect(gradeFromProbs(0.2, 0, false)).toEqual({ grade: 'poor', score: 0 });
  });
});

/** PBN suit order ♠.♥.♦.♣ → sorted Card[] (test helper). */
function hand(pbn: string): Card[] {
  const cards: Card[] = [];
  pbn.split('.').forEach((ranks, suit) => {
    for (const ch of ranks) cards.push(makeCard(suit as 0, RANK_CHARS.indexOf(ch as '2')));
  });
  return cards.sort((x, y) => x - y);
}

/** Deal with `south` at seat 2 and the remaining cards distributed arbitrarily —
 *  the observation encoding only reads the acting player's hand. */
function dealWithSouth(south: Card[]): Deal {
  const rest: Card[] = [];
  for (let c = 0; c < 52; c++) if (!south.includes(c)) rest.push(c);
  return {
    hands: [rest.slice(0, 13), rest.slice(13, 26), south, rest.slice(26, 39)],
    dealer: 0,
    vul: { ns: false, ew: false },
  };
}

describe('Bidder.evaluate with the sl model', () => {
  const bidder = new Bidder(loadPolicyModel('sl'));

  // The position that motivated the SAYC floor: South holds a perfect club
  // splinter over partner's 1♥ and the model bids it at ~85%, leaving the
  // textbook limit raise near 0%. Pins both the model's preference and that
  // grading no longer punishes the textbook alternative.
  const deal = dealWithSouth(hand('K98.QT95.AQJT5.7'));
  const calls = [b(1, 2), PASS];

  it('prefers the 4♣ splinter on a splinter-perfect hand', () => {
    const ev = bidder.evaluate(deal, calls, b(3, 2));
    expect(ev.bestCall).toBe(b(4, 0));
    expect(ev.bestProb).toBeGreaterThan(0.5);
  });

  it('floors a hand-consistent textbook bid at good/0.75', () => {
    const ev = bidder.evaluate(deal, calls, b(3, 2)); // limit raise, ~0% for the model
    expect(ev.userProb).toBeLessThan(0.05);
    expect(ev.saycConsistent).toBe(true);
    expect(ev.grade).toBe('good');
    expect(ev.score).toBe(0.75);
  });

  it('still grades hand-inconsistent calls by the model alone', () => {
    const ev = bidder.evaluate(deal, calls, b(3, 4)); // 3NT lies about 16–18 balanced
    expect(ev.saycConsistent).toBe(false);
    expect(ev.grade).toBe('poor');
    expect(ev.score).toBe(0);
  });

  it('keeps excellent for agreeing with the model, floor untouched', () => {
    const ev = bidder.evaluate(deal, calls, b(4, 0));
    expect(ev.grade).toBe('excellent');
    expect(ev.score).toBe(1);
  });
});
