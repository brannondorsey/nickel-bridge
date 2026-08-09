import { describe, expect, it } from 'vitest';
import {
  Call,
  Card,
  Contract,
  Deal,
  RANK_CHARS,
  Suit,
  auctionState,
  dealBoard,
  finalContract,
  legalCards,
  makeCard,
  playState,
} from '@bridge/core';
import { Bidder } from '../src/bidder.js';
import { isOutcomeInvariant } from '../src/claim.js';
import { loadPolicyModel } from '../src/model.js';
import { pickFromSolve, solveFutureTricks } from '../src/play-ai.js';
import { referenceInvariant } from './helpers/reference-invariant.js';

/**
 * Search-size tripwire for the brute-force oracle. The pinned-seed cases below
 * observed low hundreds of nodes; the hand-crafted micro-deals observed single
 * digits. This cap is well above those, and it exists because those numbers
 * are only *empirically* small — a case's tree size is a side effect of the
 * current model weights and DDS tie-breaks (exactly the things invariant 1
 * calls out as requiring a robot-trace fixture regen when deliberately
 * changed). If a future change to robot behavior shifts one of these seeds'
 * claim boundary deeper into the hand, the oracle — which has none of the
 * production search's pruning — blows up fast. Failing loud on a clear
 * assertion beats silently costing CI tens of seconds, or hitting vitest's
 * default timeout with an opaque error.
 */
const MAX_ORACLE_NODES = 200_000;

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));

function microDeal(north: Card[], east: Card[], south: Card[], west: Card[]): Deal {
  const sort = (h: Card[]) => [...h].sort((a, b) => a - b);
  return { hands: [sort(north), sort(east), sort(south), sort(west)], dealer: 0, vul: { ns: false, ew: false } };
}

/**
 * The auto-claim gate in server/src/game.ts asks two questions of a position.
 * The first is double dummy's: `solve.bestScore === remaining || === 0`, i.e.
 * is one side a 100% laydown. That is a claim about a minimax VALUE — DDS
 * trusting its own number, which holds only while everybody keeps playing
 * correctly. The second, on tournaments carrying `claim_rule = 'pessimistic'`,
 * is `isOutcomeInvariant`: can ANY legal card by ANY of the four seats, at any
 * point in any continuation, change the result.
 *
 * This file audits the second question the hard way — against a deliberately
 * naive enumeration of the whole tree (test/helpers/reference-invariant.ts) —
 * because a wrong `true` here is a claim that silently rewrites a real game's
 * score, and no amount of internal consistency would reveal it.
 *
 * Note what changed when the pessimistic gate shipped. This audit used to hold
 * the WINNING side to production's `chooseCard` and branch only on the losing
 * side's deviations, which is the weaker property the old gate actually had.
 * Several of the pinned seeds below now come back NOT invariant, and that is
 * the finding, not a regression: those are positions the old gate claimed and
 * the new one plays out.
 */
async function auditClaimPoint(
  deal: Deal,
  contract: Contract,
  plays: Card[],
): Promise<{ invariant: boolean; claimingSide: 0 | 1 }> {
  const totalTricks = deal.hands[0].length;
  const baseline = playState(deal, contract, plays);
  const remaining = totalTricks - baseline.completedTricks.length;
  const solve = await solveFutureTricks(deal, contract, plays);
  if (solve.bestScore !== remaining && solve.bestScore !== 0) {
    throw new Error(`test setup error: not a claim boundary (bestScore=${solve.bestScore}, remaining=${remaining})`);
  }
  const moverSide = (baseline.handToPlay % 2) as 0 | 1;
  const claimingSide = (solve.bestScore === remaining ? moverSide : 1 - moverSide) as 0 | 1;

  // The tripwire binds the ORACLE, which is the one with no pruning and no
  // bound of its own; the production search gets the same ceiling only so a
  // budget give-up can't masquerade as agreement.
  const truth = referenceInvariant(deal, contract, plays, claimingSide, MAX_ORACLE_NODES);
  const production = isOutcomeInvariant(deal, contract, plays, claimingSide, { budget: MAX_ORACLE_NODES });
  expect(production.budgetExceeded, 'production search ran out of budget on an audited position').toBe(false);
  expect(production.invariant, 'production search disagrees with brute force').toBe(truth);
  return { invariant: truth, claimingSide };
}

describe('claim soundness: hand-crafted positions with real branching for both sides', () => {
  // South declares notrump; opening leader (nextSeat of declarer) is West.
  const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

  it('denies the defense every remaining trick, however it orders two suits worth of discards', async () => {
    // Declarer/dummy hold both suits' top two cards (AK of spades, AK of
    // hearts) — an unconditional double laydown. The defense (to lead) has
    // four different legal opening choices and free discards throughout, and
    // declarer/dummy cannot squander it either.
    const deal = microDeal(
      [card(0, 'A'), card(1, 'A')], // North (dummy): SA HA
      [card(0, '2'), card(1, '2')], // East (defense)
      [card(0, 'K'), card(1, 'K')], // South (declarer): SK HK
      [card(0, '3'), card(1, '3')], // West (defense, on lead)
    );
    expect((await auditClaimPoint(deal, contract, [])).invariant).toBe(true);
  });

  it('denies declarer every remaining trick, however the defense orders its winners', async () => {
    // Mirror image: the defense holds the top two cards of both suits.
    const deal = microDeal(
      [card(0, '2'), card(1, '2')],
      [card(0, 'A'), card(1, 'A')],
      [card(0, '3'), card(1, '3')],
      [card(0, 'K'), card(1, 'K')],
    );
    expect((await auditClaimPoint(deal, contract, [])).invariant).toBe(true);
  });
});

describe('claim soundness: real dealt-and-bid boards, replayed to the actual claim boundary', () => {
  /** Mirrors advanceRobots's play loop up to (not including) the first ply
   *  where the DOUBLE-DUMMY half of its claim condition fires. */
  async function driveToClaimPoint(deal: Deal): Promise<{ contract: Contract; plays: Card[] }> {
    const bidder = new Bidder(loadPolicyModel('sl'));
    const calls: Call[] = [];
    let auction = auctionState(deal.dealer, calls);
    while (!auction.isOver) {
      calls.push(bidder.chooseCall(deal, calls));
      auction = auctionState(deal.dealer, calls);
    }
    const contract = finalContract(deal.dealer, calls);
    if (!contract) throw new Error('board passed out — no claim to audit');
    let plays: Card[] = [];
    for (;;) {
      const state = playState(deal, contract, plays);
      if (state.isOver) throw new Error('board finished before hitting a claim boundary');
      const legal = legalCards(deal, state);
      if (legal.length > 1) {
        const solve = await solveFutureTricks(deal, contract, plays);
        const remaining = 13 - state.completedTricks.length;
        if (solve.bestScore === remaining || solve.bestScore === 0) return { contract, plays };
        plays = [...plays, pickFromSolve(legal, solve)];
      } else {
        plays = [...plays, legal[0]];
      }
    }
  }

  // Pinned seeds, hand-picked (via an offline scan for small claim boundaries)
  // so the brute-force oracle stays fast — real bidding, real play, real
  // DD-determined boards, not toy suits. `invariant` records what the audit
  // finds today: false means the old gate claimed a position that a legal
  // deviation could still have spoiled, which is the whole reason the
  // pessimistic gate exists.
  const cases: [string, number, boolean][] = [
    ['audit-scan-10', 2, true], // side-to-move laydown, and genuinely unspoilable
    ['audit-scan-15', 1, true], // same
    ['audit-scan-0', 1, false], // defense fully denied double dummy — but a legal deviation spoils it
  ];

  it.each(cases)('seed %s board %i: brute force agrees with the gate (invariant=%s)', async (seed, boardNo, want) => {
    const deal = dealBoard(seed as string, boardNo as number);
    const { contract, plays } = await driveToClaimPoint(deal);
    expect(13 - playState(deal, contract, plays).completedTricks.length).toBeGreaterThan(0);
    expect((await auditClaimPoint(deal, contract, plays)).invariant).toBe(want);
  });
});
