import { Card, Contract, Deal, legalCards, playState, seededRng } from '@bridge/core';
import { getSharedDdPool } from './dd-pool.js';
import { DdSolve, buildSolveRequest, futureTricksToDdSolve, pickFromSolve, solveRequest } from './play-ai.js';
import { SampledChooseOpts, deriveKnowledge, hoistAuctionConstraints, sampleLayouts } from './play-mc.js';

/**
 * EXPERIMENTAL — card-SELECTION-noise prototype, NOT wired into any shipped
 * difficulty tier. Deliberately kept out of index.ts's barrel export, same
 * pattern as play-mc-forget.ts: nothing in server/ or the shipped Difficulty
 * type can reach this module, so it changes zero live-tournament behavior.
 * Its only consumer is tools/calibrate_stats.mjs's `playtopn` sweep.
 *
 * Every shipped and prototyped difficulty mechanism so far (K sample count,
 * auction-blindness, BID_NOISE, play-mc-forget's memory windowing) only ever
 * corrupts the acting player's BELIEF about the hidden cards — chooseCardSampled
 * still always plays the single highest-scoring legal card against whatever
 * layouts it sampled (pickFromSolve is a deterministic argmax). This module
 * asks the complementary question: what if the belief stays exactly as
 * accurate as K already makes it, but the DECISION given that belief is
 * sometimes a near-best card instead of the literal best one — the same
 * top-N-by-probability-weighted-sampling idea BID_NOISE already applies to
 * bidding, applied here to the card choice instead. Simulation research
 * (see docs/difficulty-calibration-research.md) found this is a much larger,
 * and currently completely unused, lever than any belief-side mechanism:
 * K is already floored at 1 and BID_NOISE saturates by topN≈3-4, but
 * card-selection noise keeps adding meaningful, well-separated effect through
 * at least topN≈6, and costs ZERO extra DDS solves (it re-weights the SAME
 * per-card totals the K-sample solve already computed — unlike raising K,
 * which multiplies solve count, this dial is free at inference time).
 */

export interface SelectNoiseOpts extends SampledChooseOpts {
  /**
   * Instead of always playing the single highest-scoring legal card from the
   * K-sampled layouts (topN <= 1, byte-identical to chooseCardSampled), draw
   * from the top `topN` legal cards by that same score, weighted by score.
   */
  playTopN: number;
}

/**
 * chooseCardSampled (play-mc.ts), but the final card choice is weighted-
 * sampled among the top playTopN legal cards by score instead of a
 * deterministic argmax. Belief formation (deriveKnowledge, sampleLayouts,
 * the DDS solves themselves) is untouched — identical cost and identical
 * hidden-hand inference to chooseCardSampled at the same k/useAuction.
 */
export async function chooseCardSampledNoisy(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  opts: SelectNoiseOpts,
): Promise<Card> {
  const state = playState(deal, contract, plays);
  const legal = legalCards(deal, state);
  if (legal.length === 0) throw new Error('no legal cards');
  if (legal.length === 1) return legal[0]; // forced — free and noise-free at every setting

  const know = deriveKnowledge(deal, contract, plays, opts.dealer, opts.calls);
  const constraints =
    opts.useAuction === false ? [[], [], [], []] : hoistAuctionConstraints(opts.dealer, opts.calls);
  const rng = seededRng(opts.seed);
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

  if (opts.playTopN <= 1) {
    let bestScore = -1;
    for (const c of legal) bestScore = Math.max(bestScore, totals.get(c) ?? 0);
    return pickFromSolve(legal, { cardScores: totals, bestScore });
  }

  const ranked = [...legal].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  const pool = ranked.slice(0, opts.playTopN);
  const weights = pool.map((c) => (totals.get(c) ?? 0) + 1); // +1 keeps an all-zero pool uniform rather than undefined
  const total = weights.reduce((a, b) => a + b, 0);
  const r = rng() * total;
  let acc = 0;
  for (let i = 0; i < pool.length; i++) {
    acc += weights[i];
    if (r < acc) return pool[i];
  }
  return pool[pool.length - 1];
}
