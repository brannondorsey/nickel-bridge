import { describe, expect, it } from 'vitest';
import { cardSuit, displaySort, suitDisplayOrder, trumpForDisplay } from '../../api';
import { AUCTION_END_MS } from './playAnim';
import { DRAW_BUDGET_MS, drawDuration, drawTiming } from './trumpDraw';

/** ♠ A Q 7 4 · ♥ K J 9 8 3 · ♦ 10 5 · ♣ 6 2 — suits 0=♠ 1=♥ 2=♦ 3=♣, cards suit*13 + rank */
const card = (suit: number, rank: number) => suit * 13 + rank;
const HAND = [
  card(0, 12),
  card(0, 10),
  card(0, 5),
  card(0, 2),
  card(1, 11),
  card(1, 9),
  card(1, 7),
  card(1, 6),
  card(1, 1),
  card(2, 8),
  card(2, 3),
  card(3, 4),
  card(3, 0),
];

describe('trump-first display order', () => {
  it('promotes the trump block and leaves the others in ♠♥♦♣', () => {
    expect(suitDisplayOrder(null)).toEqual([0, 1, 2, 3]);
    expect(suitDisplayOrder(1)).toEqual([1, 0, 2, 3]);
    expect(suitDisplayOrder(3)).toEqual([3, 0, 1, 2]);
    // deliberately NOT a rotation: ♥ and ♦ never end up adjacent because a
    // club contract cycled the list past them
    expect(suitDisplayOrder(3)).not.toEqual([3, 2, 1, 0]);
  });

  it('sorts a hand into that order, ranks descending, holding the same 13 cards', () => {
    const suits = (trump: number | null) => displaySort(HAND, trump).map(cardSuit);
    expect(suits(null)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 3, 3]);
    expect(suits(1)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 3, 3]);
    expect(suits(3)).toEqual([3, 3, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
    // the setting re-orders a hand; it never changes one
    expect([...displaySort(HAND, 3)].sort((a, b) => a - b)).toEqual([...HAND].sort((a, b) => a - b));
    expect(displaySort(HAND, 1).slice(0, 5)).toEqual([card(1, 11), card(1, 9), card(1, 7), card(1, 6), card(1, 1)]);
  });

  it('reads a trump suit off a contract only when the preference asks for one', () => {
    const contract = (strain: number) => ({ level: 4, strain, declarer: 2 });
    // strain counts ♣♦♥♠NT and suits count ♠♥♦♣ — the conversion is the
    // whole reason this lives in one place
    expect(trumpForDisplay(contract(2), 'left')).toBe(1); // 2 = ♥ → suit 1
    expect(trumpForDisplay(contract(3), 'left')).toBe(0); // 3 = ♠ → suit 0
    expect(trumpForDisplay(contract(0), 'left')).toBe(3); // 0 = ♣ → suit 3
    expect(trumpForDisplay(contract(4), 'left')).toBeNull(); // no-trump
    expect(trumpForDisplay(contract(2), 'suit')).toBeNull(); // preference off
    expect(trumpForDisplay(undefined, 'left')).toBeNull(); // auction unsettled
  });
});

describe('the Draw', () => {
  it('fits inside the beat the auction already spends, however long the trump suit', () => {
    expect(DRAW_BUDGET_MS).toBe(AUCTION_END_MS);
    for (let trumps = 2; trumps <= 12; trumps++) {
      expect(drawTiming(trumps).total).toBeLessThanOrEqual(DRAW_BUDGET_MS);
    }
    // ...by compressing the stagger rather than stretching the budget, so a
    // long suit draws faster per card instead of taking longer overall
    expect(drawTiming(7).stagger).toBeLessThan(drawTiming(4).stagger);
    expect(drawTiming(1).stagger).toBe(0);
  });

  it('answers zero for every hand that is already in the right order', () => {
    expect(drawDuration(HAND, null)).toBe(0); // no-trump, or the preference off
    expect(drawDuration(HAND, 0)).toBe(0); // ♠ trump: spades already lead
    expect(drawDuration([card(1, 5), card(1, 3)], 1)).toBe(0); // nothing but trumps
    expect(drawDuration([card(2, 5), card(3, 3)], 1)).toBe(0); // no trumps at all
    // ...and a hand whose only other suits already sit BEHIND the trumps
    expect(drawDuration([card(1, 5), card(2, 3), card(3, 1)], 1)).toBe(0);
  });

  it("answers the motion's own length when the hand really does re-sort", () => {
    expect(drawDuration(HAND, 1)).toBe(drawTiming(5).total);
    expect(drawDuration(HAND, 3)).toBe(drawTiming(2).total);
  });
});
