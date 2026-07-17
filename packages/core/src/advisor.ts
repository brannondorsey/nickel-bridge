import { hcp, shape } from './deck.js';
import { BidMeaning, HandConstraint, explainBid } from './sayc.js';
import { Call, Card, Seat } from './types.js';

/**
 * Bridges the SAYC explainer (teaching material) and bid grading: checks
 * whether a hand actually satisfies what a call conventionally promises.
 *
 * The AI grader is a policy network with one preferred call per position; a
 * textbook-correct alternative can get ~0% probability (e.g. a limit raise
 * when the model splinters). `saycConsistent` lets the grader recognize such
 * calls as sound instead of scoring them like nonsense. It only vouches for
 * calls whose meaning is exact AND carries machine-checkable requirements
 * (`BidMeaning.req`) the hand meets — everything else returns false, leaving
 * the model's judgment untouched.
 */
export function satisfiesConstraint(hand: Card[], req: HandConstraint): boolean {
  const points = hcp(hand);
  if (req.minHcp !== undefined && points < req.minHcp) return false;
  if (req.maxHcp !== undefined && points > req.maxHcp) return false;
  const lengths = shape(hand); // suit order ♠♥♦♣ — flip from strain order ♣♦♥♠
  if (req.suits) {
    for (const s of req.suits) {
      const len = lengths[3 - s.strain];
      if (s.min !== undefined && len < s.min) return false;
      if (s.max !== undefined && len > s.max) return false;
    }
  }
  if (req.balanced) {
    if (lengths.some((len) => len < 2)) return false;
    if (lengths.filter((len) => len === 2).length > 1) return false;
  }
  return true;
}

/** True iff `call` has an exact, constraint-carrying SAYC meaning that `hand` satisfies. */
export function saycConsistent(hand: Card[], dealer: Seat, calls: Call[], call: Call): boolean {
  const m: BidMeaning | null = explainBid(dealer, calls, call);
  return m !== null && m.exact && m.req !== undefined && satisfiesConstraint(hand, m.req);
}

/**
 * Explain `call` the way explainBid does, but flag when the actual bidder's
 * hand contradicts what the meaning promises (`req`) — e.g. a "natural,
 * length in ♠" story for a hand with a doubleton. This exists because
 * `chooseCall` (the model's own bidding) isn't guaranteed to fit the SAYC
 * story explainBid tells for a given auction; without this check the UI can
 * assert something false about a hand it actually knows.
 *
 * Only call this where showing the actual bidder's hand shape is already
 * safe (e.g. reviewing a completed board) — `handMismatch` leaks a coarse
 * fact about a hand that may still be legitimately hidden mid-auction/play.
 */
export function explainBidForHand(hand: Card[], dealer: Seat, calls: Call[], call: Call): BidMeaning | null {
  const m = explainBid(dealer, calls, call);
  if (m && m.req && !satisfiesConstraint(hand, m.req)) return { ...m, handMismatch: true };
  return m;
}
