import { describe, expect, it } from 'vitest';
import {
  Card,
  PASS,
  RANK_CHARS,
  explainBidForHand,
  makeBid,
  makeCard,
  satisfiesConstraint,
  saycConsistent,
} from '../src/index.js';

const b = makeBid;

/** PBN suit order ♠.♥.♦.♣ → sorted Card[] (test helper). */
function hand(pbn: string): Card[] {
  const cards: Card[] = [];
  pbn.split('.').forEach((ranks, suit) => {
    for (const ch of ranks) cards.push(makeCard(suit as 0, RANK_CHARS.indexOf(ch as '2')));
  });
  expect(cards).toHaveLength(13);
  return cards.sort((x, y) => x - y);
}

// The hand that motivated the advisor: a 12-HCP limit raise / splinter over 1♥.
const SPLINTER_HAND = hand('K98.QT95.AQJT5.7');
const OVER_1H = [b(1, 2), PASS]; // dealer N opens 1♥, E passes; S to act

describe('satisfiesConstraint', () => {
  it('checks HCP bounds', () => {
    expect(satisfiesConstraint(SPLINTER_HAND, { minHcp: 9, maxHcp: 12 })).toBe(true);
    expect(satisfiesConstraint(SPLINTER_HAND, { minHcp: 13 })).toBe(false);
    expect(satisfiesConstraint(SPLINTER_HAND, { maxHcp: 11 })).toBe(false);
  });

  it('checks suit lengths in strain order (♣♦♥♠)', () => {
    // 3♠ 4♥ 5♦ 1♣
    expect(satisfiesConstraint(SPLINTER_HAND, { suits: [{ strain: 2, min: 4 }] })).toBe(true);
    expect(satisfiesConstraint(SPLINTER_HAND, { suits: [{ strain: 0, max: 1 }] })).toBe(true);
    expect(satisfiesConstraint(SPLINTER_HAND, { suits: [{ strain: 3, min: 4 }] })).toBe(false);
    expect(satisfiesConstraint(SPLINTER_HAND, { suits: [{ strain: 1, max: 4 }] })).toBe(false);
  });
});

describe('saycConsistent', () => {
  it('accepts a hand-consistent limit raise', () => {
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, b(3, 2))).toBe(true);
  });

  it('accepts a hand-consistent splinter', () => {
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, b(4, 0))).toBe(true);
  });

  it('rejects a call whose promises the hand does not keep', () => {
    // 3NT response promises 16–18 balanced; this hand has 12 HCP.
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, b(3, 4))).toBe(false);
    // Jump shift to 3♣ promises 17+ and 5+ ♣.
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, b(3, 0))).toBe(false);
  });

  it('never vouches for calls without exact, constraint-carrying meanings', () => {
    // 5♣ over 1♥ has no defined meaning (generic fallback, exact: false).
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, b(5, 0))).toBe(false);
    // Stayman is an artificial relay with no req — the advisor stays silent.
    expect(saycConsistent(hand('K98.QT95.A542.72'), 2, [b(1, 4), PASS], b(2, 0))).toBe(false);
  });

  it('covers openings', () => {
    const nt = hand('KQ2.AJ95.KT5.Q43'); // 16 HCP balanced
    expect(saycConsistent(nt, 2, [], b(1, 4))).toBe(true);
    expect(saycConsistent(SPLINTER_HAND, 2, [], b(1, 4))).toBe(false); // 12 HCP, singleton
    const weakTwo = hand('KQJT95.T95.42.72'); // 6 HCP, 6 spades
    expect(saycConsistent(weakTwo, 2, [], b(2, 3))).toBe(true);
    expect(saycConsistent(weakTwo, 2, [], b(2, 2))).toBe(false); // only 3 hearts
    expect(saycConsistent(weakTwo, 2, [], PASS)).toBe(true); // 0–12 pass
    expect(saycConsistent(nt, 2, [], PASS)).toBe(false); // too strong to pass
  });

  it('covers overcalls and opener rebids', () => {
    const overcall = hand('KQJ95.T95.A42.72'); // 10 HCP, 5 spades; RHO opened 1♥
    expect(saycConsistent(overcall, 1, [b(1, 2)], b(1, 3))).toBe(true);
    expect(saycConsistent(overcall, 1, [b(1, 2)], b(1, 4))).toBe(false); // not a 1NT overcall
    // Opener (South dealt) rebids 1NT with a balanced 13 after 1♦-P-1♠-P.
    const rebid = hand('KQ2.T95.AQJT5.72'); // 13 HCP balanced (5332)
    expect(saycConsistent(rebid, 2, [b(1, 1), PASS, b(1, 3), PASS], b(1, 4))).toBe(true);
    expect(saycConsistent(rebid, 2, [b(1, 1), PASS, b(1, 3), PASS], b(2, 3))).toBe(false); // only 3 spades
  });
});

describe('explainBidForHand', () => {
  // Regression for a reported bug: North advancing South's 1NT overcall with
  // 2♠ falls through every specific bucket in sayc.ts to explainContinuation's
  // generic "Natural: length in ♠" fallback, which the model's chooseCall
  // isn't guaranteed to actually satisfy.
  const AUCTION = [PASS, b(1, 2), b(1, 4), PASS]; // N Pass, E 1H, S 1NT, W Pass — N to act with 2S

  it('flags the generic natural-length fallback when the hand does not have the length', () => {
    const shortSpades = hand('62.J8753.63.A854'); // only 2 spades
    const m = explainBidForHand(shortSpades, 0, AUCTION, b(2, 3));
    expect(m?.exact).toBe(false);
    expect(m?.title).toBe('2♠');
    expect(m?.handMismatch).toBe(true);
  });

  it('does not flag the same fallback when the hand actually backs it up', () => {
    const longSpades = hand('KQT62.J87.63.A85'); // 5 spades
    const m = explainBidForHand(longSpades, 0, AUCTION, b(2, 3));
    expect(m?.handMismatch).toBeUndefined();
  });

  it('passes through untouched when the meaning has no machine-checkable req', () => {
    // Stayman (artificial) deliberately carries no req — nothing to check.
    const hand1 = hand('K98.QT95.A542.72');
    const m = explainBidForHand(hand1, 2, [b(1, 4), PASS], b(2, 0));
    expect(m?.handMismatch).toBeUndefined();
  });
});
