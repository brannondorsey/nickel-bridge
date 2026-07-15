import {
  AuctionState,
  Call,
  Card,
  Deal,
  Seat,
  auctionState,
  legalCalls,
  saycConsistent,
} from '@bridge/core';
import { encodeObservation } from './encode.js';
import { PolicyModel } from './model.js';

export type Grade = 'excellent' | 'good' | 'fair' | 'poor';

export interface BidEvaluation {
  /** the model's preferred call */
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

  /** Deterministic robot call: the model's argmax over legal actions. */
  chooseCall(deal: Deal, calls: Call[]): Call {
    const { probs } = this.policyFor(deal, calls);
    let best = 0;
    for (let a = 1; a < 38; a++) if (probs[a] > probs[best]) best = a;
    return best;
  }

  /** Grade a (not yet applied) user call in the current auction. */
  evaluate(deal: Deal, calls: Call[], userCall: Call): BidEvaluation {
    const { probs, state } = this.policyFor(deal, calls);
    let best = 0;
    for (let a = 1; a < 38; a++) if (probs[a] > probs[best]) best = a;
    let { grade, score } = gradeFromProbs(probs[userCall], probs[best], userCall === best);
    // The model backs exactly one call per position, so a textbook-sound
    // alternative can land at ~0% (e.g. a limit raise where the model
    // splinters). If the user's call matches a defined SAYC convention that
    // their hand satisfies, floor the grade at 'good' — 'excellent' stays
    // reserved for agreeing with the model. Grading only; robot bidding
    // (chooseCall) is untouched.
    const consistent = saycConsistent(deal.hands[state.turn], deal.dealer, calls, userCall);
    if (consistent && score < 0.75) {
      grade = 'good';
      score = 0.75;
    }
    return {
      bestCall: best,
      userProb: probs[userCall],
      bestProb: probs[best],
      grade,
      score,
      saycConsistent: consistent,
      probs: Array.from(probs),
    };
  }
}
