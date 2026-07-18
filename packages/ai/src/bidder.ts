import {
  AuctionState,
  Call,
  Card,
  Deal,
  Seat,
  auctionState,
  legalCalls,
  saycConsistent,
  saycViolation,
} from '@bridge/core';
import { encodeObservation } from './encode.js';
import { PolicyModel } from './model.js';

export type Grade = 'excellent' | 'good' | 'fair' | 'poor';

export interface BidEvaluation {
  /** the SAYC-admissible call the robot would actually make (see `Bidder.chooseCall`) */
  bestCall: Call;
  /** probability the model assigns to the user's call */
  userProb: number;
  bestProb: number;
  grade: Grade;
  /** 0..1 credit used for the bidding-accuracy stat */
  score: number;
  /** the call matches a defined SAYC convention the hand satisfies (see core/advisor) */
  saycConsistent: boolean;
  /** full legal-action distribution, for the curious */
  probs: number[];
}

export function gradeFromProbs(userProb: number, bestProb: number, isBest: boolean): { grade: Grade; score: number } {
  const ratio = bestProb > 0 ? userProb / bestProb : 0;
  if (isBest || ratio >= 0.6) return { grade: 'excellent', score: 1 };
  if (ratio >= 0.2) return { grade: 'good', score: 0.75 };
  if (ratio >= 0.05) return { grade: 'fair', score: 0.4 };
  return { grade: 'poor', score: 0 };
}

export class Bidder {
  constructor(private model: PolicyModel) {}

  policyFor(deal: Deal, calls: Call[]): { probs: Float32Array; state: AuctionState; mask: boolean[] } {
    const state = auctionState(deal.dealer, calls);
    const mask = legalCalls(state);
    const obs = encodeObservation(deal.hands[state.turn], deal.dealer, deal.vul, calls, state.turn);
    return { probs: this.model.policy(obs, mask), state, mask };
  }

  /**
   * The model's argmax over legal calls, EXCLUDING any bid that violates the
   * machine-checkable hand requirements of its own exact SAYC meaning (see
   * core/advisor `saycViolation`). The imitation-learned policy mostly follows
   * SAYC but has no rule constraint of its own — left alone it will open a
   * weak two on a 5-card suit ~11% of the time it bids (measured over 400
   * deals). Filtering violations keeps every robot bid honest against the
   * explanations the UI shows, while calls the explainer can't check
   * (artificial conventions, doubles, uncovered auctions) stay under the
   * model's judgment.
   *
   * The constraint is deliberately one-sided: PASS is always admissible, even
   * where the explainer gives pass itself a constraint the hand breaks (e.g.
   * a 13-count in the opening seat). Forbidding an over-promising bid always
   * leaves a safe call available; forbidding pass would *force* the model to
   * act, and when every action it likes is also excluded, the argmax over
   * what's left is noise — a forced absurd bid is a far worse failure than a
   * missed obligation to act. Pass is legal in every live auction, so the
   * candidate set is never empty. Deterministic: ties break toward the
   * lowest action index, and the mask is a pure function of (hand, auction).
   */
  private constrainedBest(deal: Deal, calls: Call[], probs: Float32Array, state: AuctionState, mask: boolean[]): Call {
    const hand = deal.hands[state.turn];
    let best = 0; // PASS
    for (let a = 1; a < 38; a++) {
      if (!mask[a] || saycViolation(hand, deal.dealer, calls, a)) continue;
      if (probs[a] > probs[best]) best = a;
    }
    return best;
  }

  /** The model's raw argmax over legal calls, constraint or no — its unfiltered judgment. */
  private static rawBest(probs: Float32Array, mask: boolean[]): Call {
    let best = 0;
    for (let a = 1; a < 38; a++) if (mask[a] && probs[a] > probs[best]) best = a;
    return best;
  }

  /** Deterministic robot call: the model's argmax over SAYC-admissible legal actions. */
  chooseCall(deal: Deal, calls: Call[]): Call {
    const { probs, state, mask } = this.policyFor(deal, calls);
    return this.constrainedBest(deal, calls, probs, state, mask);
  }

  /**
   * Grade a (not yet applied) user call in the current auction.
   *
   * `bestCall` — what we tell the user "the robot bid" — is the constrained,
   * SAYC-admissible choice, so the teaching toast can never point at a
   * violating bid. The grade itself, though, is scored against the model's
   * raw, unconstrained judgment: a call the network rates highly is a
   * probabilistically sound bridge decision even when it oversells the hand
   * by the letter of SAYC, and grading shouldn't punish that just because
   * our guardrail wouldn't let a robot make the same call. The guardrail
   * keeps the robots' and the toast's *display* honest; it doesn't reshape
   * what counts as a good bid.
   */
  evaluate(deal: Deal, calls: Call[], userCall: Call): BidEvaluation {
    const { probs, state, mask } = this.policyFor(deal, calls);
    const bestCall = this.constrainedBest(deal, calls, probs, state, mask);
    const rawBest = Bidder.rawBest(probs, mask);
    let { grade, score } = gradeFromProbs(probs[userCall], probs[rawBest], userCall === rawBest);
    // The model backs exactly one call per position, so a textbook-sound
    // alternative can land at ~0% (e.g. a limit raise where the model
    // splinters). If the user's call matches a defined SAYC convention that
    // their hand satisfies, floor the grade at 'good' — 'excellent' stays
    // reserved for matching the model's own top choice.
    const consistent = saycConsistent(deal.hands[state.turn], deal.dealer, calls, userCall);
    if (consistent && score < 0.75) {
      grade = 'good';
      score = 0.75;
    }
    return {
      bestCall,
      userProb: probs[userCall],
      bestProb: probs[bestCall],
      grade,
      score,
      saycConsistent: consistent,
      probs: Array.from(probs),
    };
  }
}
