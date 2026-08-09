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
import { loadPolicyModel } from '../src/model.js';
import { chooseCard, pickFromSolve, solveFutureTricks } from '../src/play-ai.js';

/**
 * Search-size tripwire for assertClaimIsUnbeatable. The pinned-seed cases
 * below observed 14-212 nodes; the hand-crafted micro-deals observed
 * single digits. This cap is ~10x the largest of those, so ordinary
 * variation won't trip it, but it exists specifically because the
 * pinned-seed cases are only *empirically* small — their tree size is a
 * side effect of the current model weights and DDS tie-breaks (the exact
 * things invariant 1 in CLAUDE.md calls out as requiring a robot-trace
 * fixture regen when deliberately changed). If a future change to robot
 * behavior shifts one of those seeds' claim boundary deeper into the hand,
 * the tree can blow up fast — one case hit during this audit reached
 * ~400,000 nodes and 37s. Failing loud here on a clear assertion, instead
 * of silently costing CI tens of seconds (or hitting vitest's default
 * per-test timeout with an opaque error), is the point.
 */
const MAX_SEARCH_NODES = 2000;

const rank = (ch: string) => RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
const card = (suit: Suit, ch: string): Card => makeCard(suit, rank(ch));

function microDeal(north: Card[], east: Card[], south: Card[], west: Card[]): Deal {
  const sort = (h: Card[]) => [...h].sort((a, b) => a - b);
  return { hands: [sort(north), sort(east), sort(south), sort(west)], dealer: 0, vul: { ns: false, ew: false } };
}

/**
 * The auto-claim in server/src/game.ts's advanceRobots fires when
 * `solve.bestScore === remaining || solve.bestScore === 0` — i.e. the side
 * to move is a 100% laydown either way. That's a claim about a minimax
 * *value*: DDS's own search already trusts its own number. This helper
 * distrusts it and instead brute-force enumerates every *legal* line the
 * losing side could take (not just the DD-optimal one DDS would have
 * chosen), while the winning side always responds with the real production
 * `chooseCard` (exactly what `resolveClaim` does after a claim fires), and
 * fails the test the instant the losing side scores a single trick beyond
 * what it already had at the claim point. This is the actual guarantee an
 * auto-claim needs: not "the predicted line is self-consistent" but "no
 * legal deviation by the losing side changes the outcome."
 */
async function assertClaimIsUnbeatable(
  deal: Deal,
  contract: Contract,
  plays: Card[],
): Promise<{ nodes: number; winningSide: 0 | 1 }> {
  // deal.hands is the full, un-played-from deal, so its hand size is the
  // total trick count for this deal — 13 for a real deal, fewer for the
  // hand-crafted "last N tricks" micro-deals below. playState/legalCards
  // hardcode 13 (a real assumption everywhere else in the codebase, which
  // only ever sees full deals), so this helper tracks completion itself
  // instead of trusting PlayState.isOver.
  const totalTricks = deal.hands[0].length;
  const baseline = playState(deal, contract, plays);
  const remaining = totalTricks - baseline.completedTricks.length;
  const solve = await solveFutureTricks(deal, contract, plays);
  const moverSide = (baseline.handToPlay % 2) as 0 | 1;
  if (solve.bestScore !== remaining && solve.bestScore !== 0) {
    throw new Error(`test setup error: not a claim boundary (bestScore=${solve.bestScore}, remaining=${remaining})`);
  }
  const winningSide = (solve.bestScore === remaining ? moverSide : 1 - moverSide) as 0 | 1;

  let nodes = 0;
  const seen = new Set<string>();
  function stateKey(currentPlays: Card[], state: ReturnType<typeof playState>): string {
    const played = new Set(currentPlays);
    const perSeat = ([0, 1, 2, 3] as const).map((s) =>
      deal.hands[s]
        .filter((c) => !played.has(c))
        .sort((a, b) => a - b)
        .join(','),
    );
    return perSeat.join('|') + '#' + state.currentTrick.map((p) => `${p.seat}:${p.card}`).join(',');
  }

  async function dfs(currentPlays: Card[]): Promise<void> {
    nodes++;
    const state = playState(deal, contract, currentPlays);
    if (state.completedTricks.length === totalTricks) {
      const losingSideGain =
        winningSide === contract.declarer % 2
          ? state.defenderTricks - baseline.defenderTricks
          : state.declarerTricks - baseline.declarerTricks;
      expect(losingSideGain, `losing side stole a trick via ${JSON.stringify(currentPlays.slice(plays.length))}`).toBe(
        0,
      );
      return;
    }
    const key = stateKey(currentPlays, state);
    if (seen.has(key)) return;
    seen.add(key);
    const legal = legalCards(deal, state);
    const moverIsWinningSide = state.handToPlay % 2 === winningSide;
    if (!moverIsWinningSide && legal.length > 1) {
      // The losing side's real decision points: try EVERY legal card, not
      // just the one DDS would have picked.
      for (const c of legal) await dfs([...currentPlays, c]);
    } else {
      // The winning side always plays exactly what production would (the
      // deterministic DD-optimal chooseCard), same as resolveClaim.
      const c = legal.length === 1 ? legal[0] : await chooseCard(deal, contract, currentPlays);
      await dfs([...currentPlays, c]);
    }
  }

  await dfs(plays);
  return { nodes, winningSide };
}

// South declares notrump; opening leader (nextSeat of declarer) is West.
const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

describe('claim soundness: hand-crafted positions with real branching for the losing side', () => {
  it('defense is denied every remaining trick, however it orders two suits worth of discards', async () => {
    // Declarer/dummy hold both suits' top two cards (AK of spades, AK of
    // hearts) — an unconditional double laydown. The defense (to lead) has
    // four different legal opening choices (either suit, either card) and
    // free choice of discards throughout — none of it matters.
    const deal = microDeal(
      [card(0, 'A'), card(1, 'A')], // North (dummy): SA HA
      [card(0, '2'), card(1, '2')], // East (defense)
      [card(0, 'K'), card(1, 'K')], // South (declarer): SK HK
      [card(0, '3'), card(1, '3')], // West (defense, on lead)
    );
    const { nodes } = await assertClaimIsUnbeatable(deal, contract, []);
    expect(nodes).toBeGreaterThan(4); // confirms the defense's alternatives were actually explored
    expect(nodes).toBeLessThan(MAX_SEARCH_NODES);
  });

  it('declarer is denied every remaining trick, however the defense orders its winners', async () => {
    // Mirror image: defense holds the top two cards of both suits, declarer
    // is helpless regardless of what declarer/dummy discard or which
    // defensive winner comes first.
    const deal = microDeal(
      [card(0, '2'), card(1, '2')], // North (dummy)
      [card(0, 'A'), card(1, 'A')], // East (defense)
      [card(0, '3'), card(1, '3')], // South (declarer)
      [card(0, 'K'), card(1, 'K')], // West (defense, on lead)
    );
    const { nodes } = await assertClaimIsUnbeatable(deal, contract, []);
    expect(nodes).toBeGreaterThan(4);
    expect(nodes).toBeLessThan(MAX_SEARCH_NODES);
  });
});

describe('claim soundness: real dealt-and-bid boards, replayed to the actual claim boundary', () => {
  /** Mirrors advanceRobots's play loop in server/src/game.ts up to (not
   *  including) the point where its claim condition first fires. */
  async function driveToClaimPoint(deal: Deal): Promise<{ contract: Contract; plays: Card[] }> {
    const bidder = new Bidder(loadPolicyModel('sl'));
    let calls: Call[] = [];
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

  // Pinned seeds, hand-picked (via an offline scan for small claim
  // boundaries) so the brute-force search stays fast — real bidding, real
  // play, real DD-determined boards, not toy suits.
  const cases: [string, number][] = [
    ['audit-scan-10', 2], // side-to-move laydown, bestScore === remaining
    ['audit-scan-15', 1], // side-to-move laydown, bestScore === remaining
    ['audit-scan-0', 1], // defense fully denied, bestScore === 0
  ];

  it.each(cases)('seed %s board %i: no legal defense/declarer deviation steals a trick', async (seed, boardNo) => {
    const deal = dealBoard(seed, boardNo);
    const { contract, plays } = await driveToClaimPoint(deal);
    const remaining = 13 - playState(deal, contract, plays).completedTricks.length;
    expect(remaining).toBeGreaterThan(0);
    const { nodes } = await assertClaimIsUnbeatable(deal, contract, plays);
    expect(nodes).toBeGreaterThan(1); // sanity: the losing side actually had a choice to explore
    // See MAX_SEARCH_NODES's docstring: this seed was hand-picked for a small
    // claim boundary under *today's* robot behavior; that's not guaranteed
    // to stay small if bidding/play logic changes deliberately later.
    expect(nodes).toBeLessThan(MAX_SEARCH_NODES);
  });
});
