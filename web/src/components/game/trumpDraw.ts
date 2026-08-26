import { cardSuit } from '../../api';
import { AUCTION_END_MS } from './playAnim';

/**
 * "The Draw" — the motion that moves the trump suit to the left of a hand
 * when the contract settles ("Trump placement · LEFT SIDE",
 * users.trump_placement — the default, so this is what most boards do; a
 * player who has asked for SUIT ORDER instead never sees it).
 *
 * Two beats, and the order of them is the whole idea. First the other suits
 * slide right together, opening a gap at the left edge. Then the trumps are
 * drawn out one at a time — highest first, so the new block builds left to
 * right — each lifting clear of the fan and tucking into the gap. What the
 * player sees is a hand being SORTED, not the result of having sorted it,
 * which is what makes it legible: a first-timer learns which cards are trumps
 * by watching them singled out, without a colour, an outline or a caption
 * saying so.
 *
 * Chosen over two alternatives that were prototyped alongside it in
 * docs/trump-placement-concepts.html (open it — all three still run): "The
 * Cut", where the trump block lifts and travels as one rigid packet, and
 * "The Squeeze", where every card takes the shortest path at once. Both are
 * shorter, and both say only "the order changed"; this one says which suit
 * changed it.
 *
 * This module is the pure half — what moves, when. The DOM work is in
 * HandFan.tsx, which owns the elements and measures them.
 */

/** the gap opens before the first trump is drawn — a beat, not a pause */
const LEAD_MS = 140;
/** one trump card's flight, out of the fan and into the gap */
const CARD_MS = 380;
/**
 * Between consecutive trump cards, at the top of the range — and the only
 * bound there is. A floor was tried and taken back out: the budget below
 * already stops the stagger anywhere useful, since the deepest hand that can
 * re-sort at all is twelve trumps and one other card (thirteen trumps is
 * already in order, so it never draws), which leaves 33ms between cards. A
 * floor could only ever fire below that, i.e. only by overrunning the budget
 * it was supposed to be sharing — which is exactly what the test caught.
 */
const MAX_STAGGER_MS = 90;
/** the other suits' single slide, under the trumps and ahead of them */
const REST_MS = 320;

/**
 * What the whole motion is allowed to cost.
 *
 * Deliberately the beat the auction ALREADY spends between its final call and
 * the board turning over (AUCTION_END_MS), rather than a number of its own:
 * the Draw runs in the same silence, so tying it to that constant is what
 * keeps "the auction ended, now look at your hand" a single event instead of
 * two consecutive waits. The stagger compresses to fit rather than the budget
 * stretching, so a seven-card trump suit draws faster per card than a
 * four-card one and both finish in the same span — the alternative is a
 * motion whose length advertises the length of your suit.
 */
export const DRAW_BUDGET_MS = AUCTION_END_MS;

export interface DrawTiming {
  /** ms before the first trump card starts moving */
  lead: number;
  /** ms between consecutive trump cards (0 for a singleton) */
  stagger: number;
  /** one trump card's flight */
  cardMs: number;
  /** the non-trump slide, which starts at 0 */
  restMs: number;
  /** total wall-clock, first movement to last card landing */
  total: number;
}

/**
 * The Draw's timing for a trump holding of `trumps` cards. Pure, so the
 * pacing can be asserted without a DOM — and so Board.tsx can ask how long
 * the motion will take BEFORE it starts, which is what lets it hold the
 * opening lead until the hand has finished sorting itself (see
 * stagePlaySteps' `resortMs`).
 */
export function drawTiming(trumps: number): DrawTiming {
  const gaps = Math.max(0, trumps - 1);
  const room = DRAW_BUDGET_MS - LEAD_MS - CARD_MS;
  const stagger = gaps === 0 ? 0 : Math.min(MAX_STAGGER_MS, Math.floor(room / gaps));
  return {
    lead: LEAD_MS,
    stagger,
    cardMs: CARD_MS,
    restMs: REST_MS,
    total: LEAD_MS + stagger * gaps + CARD_MS,
  };
}

/**
 * How long the Draw will run for this hand under this trump suit, or 0 when
 * there is nothing to draw.
 *
 * Zero is the common case and has to be exact rather than approximated,
 * because it is what keeps the motion honest on the boards where the order
 * does not change: a spade contract (spades already lead), a no-trump
 * contract (no trump suit at all, so `trump` is null before this is reached)
 * and a hand with no trumps in it all move nothing, and a fan that pauses to
 * animate nothing is worse than one that never pauses. It takes the ORDER
 * rather than the count so the no-op is decided by the same comparison the
 * render makes — a hand of only trumps, or only one other suit above them,
 * is already in the right order and is caught here too.
 */
export function drawDuration(hand: number[], trump: number | null): number {
  if (trump === null) return 0;
  const trumps = hand.filter((c) => cardSuit(c) === trump).length;
  if (trumps === 0 || trumps === hand.length) return 0;
  // nothing precedes the trump block already? then nothing has to move
  if (hand.every((c) => cardSuit(c) === trump || cardSuit(c) > trump)) return 0;
  return drawTiming(trumps).total;
}
