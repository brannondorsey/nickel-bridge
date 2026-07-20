import { describe, expect, it } from 'vitest';
import {
  Call,
  Card,
  Deal,
  PASS,
  RANK_CHARS,
  auctionState,
  dealBoard,
  isBid,
  makeBid,
  makeCard,
  saycViolation,
} from '@bridge/core';
import { Bidder, bidDecisionSeed, gradeFromProbs } from '../src/bidder.js';
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

  it('floors textbook openings too (weak two where the model preempts higher)', () => {
    // 7-card suit, 6 HCP: the model opens 3♠ (~100%), but a 2♠ weak two still
    // keeps its promises (5–11 HCP, 6+ spades) — judgment call, not a blunder.
    const preempt = dealWithSouth(hand('KQJT952.T95.4.72'));
    preempt.dealer = 2;
    const ev = bidder.evaluate(preempt, [], b(2, 3));
    expect(ev.bestCall).toBe(b(3, 3));
    expect(ev.saycConsistent).toBe(true);
    expect(ev.grade).toBe('good');
    expect(ev.score).toBe(0.75);
  });
});

describe('SAYC-constrained robot bidding', () => {
  const bidder = new Bidder(loadPolicyModel('sl'));

  /** The model's unconstrained preference, for before/after contrast. */
  function rawArgmax(deal: Deal, calls: Call[]): Call {
    const { probs } = bidder.policyFor(deal, calls);
    let best = 0;
    for (let a = 1; a < 38; a++) if (probs[a] > probs[best]) best = a;
    return best;
  }

  // Pinned instances (found by sweeping sayc-sweep-* seeds) where the raw
  // model's argmax is a bid that violates its own SAYC meaning's hand
  // requirements. chooseCall must refuse each and pick an admissible call.
  const violations: [string, string, number, Call[], Call, Call][] = [
    // [description, seed, boardNo, calls so far, raw model bid, constrained choice]
    ['2♠ weak two on a 5-card suit → pass', 'sayc-sweep-0', 5, [], b(2, 3), PASS],
    ['1♠ opening on 11 HCP → pass', 'sayc-sweep-0', 6, [], b(1, 3), PASS],
    ['jump shift rebid without the points → the honest raise', 'sayc-sweep-0', 10, [b(1, 3), PASS, b(2, 0), PASS], b(4, 1), b(3, 0)],
  ];

  it.each(violations)('refuses %s', (_name, seed, boardNo, calls, rawBid, constrained) => {
    const deal = dealBoard(seed, boardNo);
    const seat = auctionState(deal.dealer, calls).turn;
    expect(rawArgmax(deal, calls)).toBe(rawBid); // the model still wants the violation…
    expect(saycViolation(deal.hands[seat], deal.dealer, calls, rawBid)).toBe(true);
    expect(bidder.chooseCall(deal, calls)).toBe(constrained); // …and chooseCall refuses it
  });

  it('agreeing with the displayed (constrained) robot choice is excellent', () => {
    const deal = dealBoard('sayc-sweep-0', 5); // the 5-card weak-two hand
    const ev = bidder.evaluate(deal, [], PASS);
    expect(ev.bestCall).toBe(PASS);
    expect(ev.grade).toBe('excellent');
  });

  it('grades the excluded raw favorite by the model’s own confidence, unpunished by the guardrail', () => {
    const deal = dealBoard('sayc-sweep-0', 5); // the 5-card weak-two hand
    const ev = bidder.evaluate(deal, [], b(2, 3)); // 2♠ — the model's true favorite, though the guardrail refuses it
    expect(ev.bestCall).toBe(PASS); // displayed "robot bid" stays SAYC-honest
    expect(ev.grade).toBe('excellent'); // but the score reflects real model confidence, not the guardrail
    expect(ev.score).toBe(1);
  });

  it('bestProb pairs with the displayed bestCall, independent of the grading denominator', () => {
    const deal = dealBoard('sayc-sweep-0', 10);
    const calls = [b(1, 3), PASS, b(2, 0), PASS];
    const ev = bidder.evaluate(deal, calls, b(4, 1)); // 4♦ jump shift — the raw favorite, a violation
    expect(ev.bestCall).toBe(b(3, 0)); // the honest raise is what's shown as "the robot's choice"
    expect(ev.bestProb).toBeLessThan(ev.userProb); // bestProb describes bestCall, not the (higher) grading denominator
    expect(ev.grade).toBe('excellent'); // yet the score matches the model's real confidence in 4♦
    expect(ev.score).toBe(1);
  });

  it('never bids a call that violates its own SAYC meaning, across whole auctions', () => {
    for (let boardNo = 1; boardNo <= 8; boardNo++) {
      const deal = dealBoard('sayc-guard-0', boardNo);
      const calls: Call[] = [];
      let state = auctionState(deal.dealer, calls);
      while (!state.isOver) {
        const call = bidder.chooseCall(deal, calls);
        if (isBid(call)) {
          expect(
            saycViolation(deal.hands[state.turn], deal.dealer, calls, call),
            `board ${boardNo}, after [${calls.join(' ')}]: call ${call}`,
          ).toBe(false);
        }
        calls.push(call);
        state = auctionState(deal.dealer, calls);
      }
    }
  });

  // Artificial conventions carry no machine-checkable req (deliberately —
  // see BidMeaning.req), so the constraint must never mask them. Each row is
  // a textbook hand where the model's conventional call has to survive.
  const conventions: [string, string, number, Call[], Call][] = [
    // [convention, south hand, dealer, calls (N opens), expected call]
    ['Stayman', 'KQ52.A874.752.63', 0, [b(1, 4), PASS], b(2, 0)],
    ['Jacoby transfer to hearts', '84.J9832.Q75.862', 0, [b(1, 4), PASS], b(2, 1)],
    ['Jacoby transfer to spades', 'J9832.84.Q75.862', 0, [b(1, 4), PASS], b(2, 2)],
    ['2♦ waiting over 2♣', '764.J983.752.8632', 0, [b(2, 0), PASS], b(2, 1)],
    ['Blackwood over partner’s preempt', 'KJT.AK96.AT9.A54', 3, [PASS, b(3, 1), PASS], b(4, 4)],
  ];

  it.each(conventions)('still bids %s', (_name, pbn, dealer, calls, expected) => {
    const deal = dealWithSouth(hand(pbn));
    deal.dealer = dealer as 0 | 1 | 2 | 3;
    expect(bidder.chooseCall(deal, calls)).toBe(expected);
  });
});

describe('difficulty-aware bidding noise', () => {
  const bidder = new Bidder(loadPolicyModel('sl'));

  it('omitted opts and difficulty "perfect" are byte-identical to the plain call', () => {
    for (let boardNo = 1; boardNo <= 6; boardNo++) {
      const deal = dealBoard('bid-noise-perfect-0', boardNo);
      const calls: Call[] = [];
      let state = auctionState(deal.dealer, calls);
      while (!state.isOver) {
        const plain = bidder.chooseCall(deal, calls);
        const perfect = bidder.chooseCall(deal, calls, { difficulty: 'perfect', seed: 'unused' });
        expect(perfect).toBe(plain);
        calls.push(plain);
        state = auctionState(deal.dealer, calls);
      }
    }
  });

  it('is deterministic: identical (deal, calls, difficulty, seed) always returns the same call', () => {
    const deal = dealBoard('bid-noise-det-0', 3);
    const seed = bidDecisionSeed('bid-noise-det-0', 3, 0);
    const first = bidder.chooseCall(deal, [], { difficulty: 'beginner', seed });
    for (let i = 0; i < 10; i++) {
      expect(bidder.chooseCall(deal, [], { difficulty: 'beginner', seed })).toBe(first);
    }
  });

  it('two independent Bidder instances at the same seed pick the same call (duplicate fairness)', () => {
    const bidderA = new Bidder(loadPolicyModel('sl'));
    const bidderB = new Bidder(loadPolicyModel('sl'));
    for (let boardNo = 1; boardNo <= 4; boardNo++) {
      const deal = dealBoard('bid-noise-fair-0', boardNo);
      const seed = bidDecisionSeed('bid-noise-fair-0', boardNo, 0);
      expect(bidderA.chooseCall(deal, [], { difficulty: 'intermediate', seed })).toBe(
        bidderB.chooseCall(deal, [], { difficulty: 'intermediate', seed }),
      );
    }
  });

  it('throws if a non-perfect difficulty is given without a seed', () => {
    const deal = dealBoard('bid-noise-noseed-0', 1);
    expect(() => bidder.chooseCall(deal, [], { difficulty: 'beginner' })).toThrow();
  });

  it('expert (topN=1) always matches the pure constrained argmax, never just usually', () => {
    for (let boardNo = 1; boardNo <= 8; boardNo++) {
      const deal = dealBoard('bid-noise-expert-0', boardNo);
      const calls: Call[] = [];
      let state = auctionState(deal.dealer, calls);
      while (!state.isOver) {
        const plain = bidder.chooseCall(deal, calls);
        const seed = bidDecisionSeed('bid-noise-expert-0', boardNo, calls.length);
        const expert = bidder.chooseCall(deal, calls, { difficulty: 'expert', seed });
        expect(expert).toBe(plain);
        calls.push(plain);
        state = auctionState(deal.dealer, calls);
      }
    }
  });

  it('beginner noise never violates the SAYC guardrail, and sometimes deviates from pure argmax', () => {
    let deviations = 0;
    for (let boardNo = 1; boardNo <= 30; boardNo++) {
      const deal = dealBoard('bid-noise-sweep-0', boardNo);
      const calls: Call[] = [];
      let state = auctionState(deal.dealer, calls);
      while (!state.isOver) {
        const plain = bidder.chooseCall(deal, calls);
        const seed = bidDecisionSeed('bid-noise-sweep-0', boardNo, calls.length);
        const noisy = bidder.chooseCall(deal, calls, { difficulty: 'beginner', seed });
        if (isBid(noisy)) {
          expect(saycViolation(deal.hands[state.turn], deal.dealer, calls, noisy)).toBe(false);
        }
        if (noisy !== plain) deviations++;
        // advance the auction with the plain (unconstrained-by-noise) sequence so every
        // board's decision points are the same regardless of what noise picked upstream
        calls.push(plain);
        state = auctionState(deal.dealer, calls);
      }
    }
    expect(deviations).toBeGreaterThan(0);
  });
});
