import { describe, expect, it } from 'vitest';
import {
  Card,
  PASS,
  RANK_CHARS,
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
    // Pass has a meaning but carries no req — the advisor stays silent.
    expect(saycConsistent(SPLINTER_HAND, 0, OVER_1H, PASS)).toBe(false);
  });
});
