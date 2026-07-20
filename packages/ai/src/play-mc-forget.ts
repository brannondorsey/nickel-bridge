import { Call, Card, Contract, Deal, Seat, cardSuit, legalCards, playState, seededRng } from '@bridge/core';
import { getSharedDdPool } from './dd-pool.js';
import { DdSolve, buildSolveRequest, futureTricksToDdSolve, pickFromSolve, solveRequest } from './play-ai.js';
import {
  DecisionKnowledge,
  SampledChooseOpts,
  deriveKnowledge,
  hoistAuctionConstraints,
  sampleLayouts,
} from './play-mc.js';

/**
 * EXPERIMENTAL — card-"forgetting" prototype, NOT wired into any shipped
 * difficulty tier. Deliberately kept out of index.ts's barrel export: nothing
 * in server/ or the shipped Difficulty type can reach this module, so it
 * changes zero live-tournament behavior. Its only consumer is
 * tools/calibrate_k.mjs's --forget-window sweep, used to decide whether
 * memory decay is worth wiring into difficulty.ts for real (see
 * CONTRIBUTING.md's "Robot difficulty" sections for the shipped mechanisms).
 *
 * Real-world precedent: some trick-taking-game bots (Hearts/Spades) gate
 * opponent strength via partial/decaying card-counting — full tracking of
 * recent tricks, degraded tracking of older ones — as an axis distinct from
 * hidden-hand sample count. chooseCardSampled's voids are otherwise a
 * complete, exact function of public state (inferVoids in play-mc.ts); this
 * module asks what happens if that memory is windowed instead.
 */

export interface ForgetOpts {
  /** completed tricks within this many tricks of the current decision are always remembered */
  memoryWindow: number;
  /**
   * tricks OLDER than memoryWindow are forgotten with this probability
   * (seeded, via the same rng stream as the rest of the decision) instead of
   * a hard cutoff. Omit for a pure hard window (never remembered beyond it).
   */
  forgetProb?: number;
}

/**
 * Like inferVoids (play-mc.ts) but windowed: a trick outside memoryWindow
 * only contributes its shown-out evidence if it's "remembered" — always, for
 * a hard window (forgetProb omitted), or with probability (1 - forgetProb)
 * otherwise. Consumes one rng draw per out-of-window trick when forgetProb is
 * set; zero draws for a hard window, matching inferVoids' determinism.
 */
export function inferVoidsForgetful(
  contract: Contract,
  plays: Card[],
  opts: ForgetOpts,
  rng: () => number,
): boolean[][] {
  const stub: Deal = { hands: [[], [], [], []], dealer: 0, vul: { ns: false, ew: false } };
  const state = playState(stub, contract, plays);
  const voids: boolean[][] = [0, 1, 2, 3].map(() => [false, false, false, false]);
  const tricks = [...state.completedTricks, state.currentTrick];
  const completedCount = state.completedTricks.length;
  tricks.forEach((trick, idx) => {
    if (trick.length === 0) return;
    const tricksAgo = completedCount - idx; // 0 = the trick in progress
    const inWindow = tricksAgo <= opts.memoryWindow;
    const remembered = inWindow || (opts.forgetProb !== undefined && rng() >= opts.forgetProb);
    if (!remembered) return;
    const led = cardSuit(trick[0].card);
    for (const p of trick.slice(1)) {
      if (cardSuit(p.card) !== led) voids[p.seat][led] = true;
    }
  });
  return voids;
}

/** deriveKnowledge (play-mc.ts) with voids replaced by the windowed/decayed inference above. */
export function deriveKnowledgeForgetful(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  dealer: Seat,
  calls: Call[],
  opts: ForgetOpts,
  rng: () => number,
): DecisionKnowledge {
  const base = deriveKnowledge(deal, contract, plays, dealer, calls);
  return { ...base, voids: inferVoidsForgetful(contract, plays, opts, rng) };
}

export interface ForgetfulChooseOpts extends SampledChooseOpts, ForgetOpts {}

/**
 * chooseCardSampled (play-mc.ts), but voids come from deriveKnowledgeForgetful
 * instead of the complete public record. Same seeded-rng-stream, worker-pool,
 * dedup-by-weighted-layout machinery; only the knowledge source differs.
 */
export async function chooseCardSampledForgetful(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  opts: ForgetfulChooseOpts,
): Promise<Card> {
  const state = playState(deal, contract, plays);
  const legal = legalCards(deal, state);
  if (legal.length === 0) throw new Error('no legal cards');
  if (legal.length === 1) return legal[0];

  const rng = seededRng(opts.seed);
  const know = deriveKnowledgeForgetful(deal, contract, plays, opts.dealer, opts.calls, opts, rng);
  const constraints =
    opts.useAuction === false ? [[], [], [], []] : hoistAuctionConstraints(opts.dealer, opts.calls);
  const layouts = sampleLayouts(know, constraints, Math.max(1, Math.floor(opts.k)), rng);

  const totals = new Map<Card, number>();
  const solves = await Promise.all(
    layouts.map(async (layout) => {
      const req = buildSolveRequest(layout.deal, contract, plays);
      const pool = getSharedDdPool();
      if (pool) {
        try {
          return futureTricksToDdSolve(await pool.solve(req));
        } catch {
          // degraded pool — fall through to the main-thread solve
        }
      }
      return futureTricksToDdSolve(await solveRequest(req));
    }),
  );
  layouts.forEach((layout, i) => {
    const solve: DdSolve = solves[i];
    for (const c of legal) {
      totals.set(c, (totals.get(c) ?? 0) + layout.weight * (solve.cardScores.get(c) ?? 0));
    }
  });

  let bestScore = -1;
  for (const c of legal) bestScore = Math.max(bestScore, totals.get(c) ?? 0);
  return pickFromSolve(legal, { cardScores: totals, bestScore });
}
