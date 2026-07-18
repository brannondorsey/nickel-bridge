import {
  Call,
  Card,
  Contract,
  Deal,
  HandConstraint,
  PASS,
  Seat,
  Vulnerability,
  cardSuit,
  explainBid,
  handToPbn,
  legalCards,
  partnerOf,
  playState,
  satisfiesConstraint,
  seededRng,
} from '@bridge/core';
import { getSharedDdPool } from './dd-pool.js';
import { DdSolve, buildSolveRequest, futureTricksToDdSolve, pickFromSolve, solveRequest } from './play-ai.js';

/**
 * Sampled double-dummy card play — the non-'expert' robot brain.
 *
 * Instead of solving the true deal (perfect knowledge), a decision samples K
 * layouts of the cards the acting player cannot see — consistent with the
 * auction (SAYC hand constraints) and the play so far (shown-out voids) —
 * solves each layout double-dummy, and plays the card with the best total
 * tricks across samples. This is the classic GIB/Argine architecture.
 *
 * Everything here is a pure deterministic function of PUBLIC state plus a
 * seed string derived from the tournament seed, so every player on the same
 * board still faces identical robots (invariant 1 in CONTRIBUTING.md); K is
 * the difficulty dial (see difficulty.ts).
 *
 * Efficiency levers (beyond the worker pool added separately):
 *  - sampled layouts are deduped per decision (endgames collapse to a handful
 *    of unique positions no matter how large K is), and each unique layout is
 *    solved once, weighted by multiplicity;
 *  - the server's claim gate short-circuits DD-determined tails, so sampling
 *    never runs on positions with a foregone conclusion;
 *  - forced (single-legal-card) nodes return before any sampling.
 */

/** Everything the acting player legitimately knows at a card-play decision. */
export interface DecisionKnowledge {
  /** the player making the decision: handToPlay, or declarer when handToPlay is dummy */
  actor: Seat;
  handToPlay: Seat;
  contract: Contract;
  dealer: Seat;
  calls: Call[];
  plays: Card[];
  vul: Vulnerability;
  /** original per-seat hand size (uniform across seats — public) */
  handSize: number;
  /** every card identity in play — the deck's composition is public (52 cards
   *  on a real board; the dealt subset on a micro-deal); only the per-seat
   *  assignment is hidden */
  deck: Card[];
  /** ORIGINAL full hands the actor may see: own hand, plus dummy once visible */
  knownHands: Map<Seat, Card[]>;
  /** cards each seat has played so far, in play order (public) */
  playedBySeat: Card[][];
  /** cards each seat still holds (public counts; contents hidden for unseen seats) */
  remainingCounts: number[];
  /** voids[seat][suit] — seat failed to follow that suit at some point (public) */
  voids: boolean[][];
}

/**
 * Which suits each seat has shown out of, from the play so far. A seat that
 * doesn't follow to the led suit provably holds no more cards of it — the one
 * hard logical constraint on hidden hands, never relaxed by the sampler.
 *
 * playState's trick/seat attribution is derived purely from (contract, plays)
 * — it never reads the hands — so passing a stub deal is sound and keeps this
 * helper usable without any hidden information.
 */
export function inferVoids(contract: Contract, plays: Card[]): boolean[][] {
  const stub: Deal = { hands: [[], [], [], []], dealer: 0, vul: { ns: false, ew: false } };
  const state = playState(stub, contract, plays);
  const voids: boolean[][] = [0, 1, 2, 3].map(() => [false, false, false, false]);
  const tricks = [...state.completedTricks, state.currentTrick];
  for (const trick of tricks) {
    if (trick.length === 0) continue;
    const led = cardSuit(trick[0].card);
    for (const p of trick.slice(1)) {
      if (cardSuit(p.card) !== led) voids[p.seat][led] = true;
    }
  }
  return voids;
}

/**
 * Derive the acting player's knowledge for the current decision. This is the
 * ONLY function in the sampled-play path that touches the true deal, and it
 * reads exactly:
 *   1. deal.hands[actor] — the actor's own original hand (the actor is the
 *      declarer when dummy is on play, so "own" covers dummy control);
 *   2. deal.hands[dummy] — iff plays.length >= 1 (dummy faces up after the
 *      opening lead; the opening leader sees only their own hand, and the
 *      declarer never acts before the lead);
 *   3. per-seat hand SIZE (uniform, public).
 * Everything else is reconstructed from public state (calls, plays, contract).
 * Downstream sampling consumes this struct only, so hidden hands cannot leak.
 */
export function deriveKnowledge(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  dealer: Seat,
  calls: Call[],
): DecisionKnowledge {
  const state = playState(deal, contract, plays);
  const dummy = partnerOf(contract.declarer);
  const actor = state.handToPlay === dummy ? contract.declarer : state.handToPlay;

  const knownHands = new Map<Seat, Card[]>();
  knownHands.set(actor, [...deal.hands[actor]]);
  if (plays.length >= 1) knownHands.set(dummy, [...deal.hands[dummy]]);

  const playedBySeat: Card[][] = [[], [], [], []];
  for (const trick of [...state.completedTricks, state.currentTrick]) {
    for (const p of trick) playedBySeat[p.seat].push(p.card);
  }

  const handSize = deal.hands[actor].length;
  const remainingCounts = playedBySeat.map((played) => handSize - played.length);

  // Flattening all four hands reads only the multiset union — the deck's
  // composition, which every player knows. Per-seat assignment never leaves
  // this function except through knownHands.
  const deck = deal.hands.flat().sort((a, b) => a - b);

  return {
    actor,
    handToPlay: state.handToPlay,
    contract,
    dealer,
    calls,
    plays,
    vul: deal.vul,
    handSize,
    deck,
    knownHands,
    playedBySeat,
    remainingCounts,
    voids: inferVoids(contract, plays),
  };
}

/** One hoisted, machine-checkable promise a seat made during the auction. */
export interface SeatConstraint {
  /** pass-derived constraints are soft evidence and relax before bid constraints */
  fromPass: boolean;
  req: HandConstraint;
}

/**
 * The auction's machine-checkable hand constraints, per seat, computed once
 * per decision. Each call is explained against its own auction PREFIX
 * (explainBid(dealer, calls.slice(0, i), calls[i])) — the meaning of a call
 * depends on what came before it, never on what followed. Only exact meanings
 * carrying a `req` constrain (artificial conventions, doubles, and uncovered
 * auctions contribute nothing, matching the bidding guardrail's reach).
 */
export function hoistAuctionConstraints(dealer: Seat, calls: Call[]): SeatConstraint[][] {
  const out: SeatConstraint[][] = [[], [], [], []];
  for (let i = 0; i < calls.length; i++) {
    const seat = ((dealer + i) % 4) as Seat;
    const m = explainBid(dealer, calls.slice(0, i), calls[i]);
    if (m !== null && m.exact && m.req !== undefined) {
      out[seat].push({ fromPass: calls[i] === PASS, req: m.req });
    }
  }
  return out;
}

/** A unique sampled layout and how many of the K draws produced it. */
export interface WeightedLayout {
  /** full Deal: known hands true, hidden hands sampled — all ORIGINAL hands,
   *  so remainingCards()/buildSolveRequest() work on it unchanged */
  deal: Deal;
  weight: number;
}

/**
 * Deterministic rejection budgets for the relaxation ladder. Sampling tries
 * to honor everything the auction promised; when the accumulated evidence is
 * contradictory (someone psyched, or a guardrail-forced pass hid a big hand),
 * constraints shed in evidence order — pass-derived first (a robot pass can
 * legitimately hide 13+ HCP when the guardrail vetoed its bids; humans pass
 * freely), positive-bid constraints second (guardrail-enforced for robots,
 * near-always honest for humans). Shown-out voids are logical certainties and
 * NEVER relax. All budgets are fixed so the draw sequence — and therefore the
 * robot's card — is identical for every player at the same position.
 */
export const SAMPLER = {
  /** draws per accepted sample with all auction constraints */
  TRIES_FULL: 200,
  /** then: pass-derived constraints dropped, bid constraints kept */
  TRIES_NO_PASS: 200,
  /** then: voids only */
  TRIES_VOIDS_ONLY: 2000,
};

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Greedy void-respecting assignment of a shuffled pool to the hidden seats:
 * most-suit-constrained seat first, each taking the earliest unused cards of
 * suits it can still hold. Returns remaining (unplayed) cards per hidden seat,
 * or null when the greedy order strands a seat (rare — retried by the ladder).
 */
function greedyAssign(
  pool: Card[],
  hiddenSeats: Seat[],
  counts: number[],
  voids: boolean[][],
): Map<Seat, Card[]> | null {
  // seats with MORE voids (fewer allowed suits) pick first; seat index breaks ties
  const order = [...hiddenSeats].sort(
    (a, b) => voids[b].filter(Boolean).length - voids[a].filter(Boolean).length || a - b,
  );
  const used = new Array<boolean>(pool.length).fill(false);
  const result = new Map<Seat, Card[]>();
  for (const seat of order) {
    const hand: Card[] = [];
    for (let i = 0; i < pool.length && hand.length < counts[seat]; i++) {
      if (used[i] || voids[seat][cardSuit(pool[i])]) continue;
      used[i] = true;
      hand.push(pool[i]);
    }
    if (hand.length < counts[seat]) return null;
    result.set(seat, hand);
  }
  return result;
}

/**
 * Exact backtracking fallback: assign every pool card to some hidden seat
 * with capacity that isn't void in its suit. A valid assignment always exists
 * (the true deal is one), so this terminates with a layout even when the
 * greedy pass keeps stranding seats. Deterministic: cards in pool order,
 * seats tried in index order.
 */
function backtrackAssign(
  pool: Card[],
  hiddenSeats: Seat[],
  counts: number[],
  voids: boolean[][],
): Map<Seat, Card[]> {
  const need = hiddenSeats.map((s) => counts[s]);
  const hands: Card[][] = hiddenSeats.map(() => []);
  const assign = (idx: number): boolean => {
    if (idx === pool.length) return need.every((n) => n === 0);
    const card = pool[idx];
    for (let h = 0; h < hiddenSeats.length; h++) {
      if (need[h] === 0 || voids[hiddenSeats[h]][cardSuit(card)]) continue;
      need[h]--;
      hands[h].push(card);
      if (assign(idx + 1)) return true;
      need[h]++;
      hands[h].pop();
    }
    return false;
  };
  if (!assign(0)) throw new Error('no void-respecting layout exists — impossible for a legal play sequence');
  return new Map(hiddenSeats.map((s, i) => [s, hands[i]]));
}

/**
 * Draw K hidden-hand layouts consistent with the public evidence, deduped by
 * position with multiplicity weights. See SAMPLER for the relaxation ladder.
 */
export function sampleLayouts(
  know: DecisionKnowledge,
  constraints: SeatConstraint[][],
  k: number,
  rng: () => number,
): WeightedLayout[] {
  const playedSet = new Set(know.plays);
  const knownSet = new Set<Card>();
  for (const [, hand] of know.knownHands) for (const c of hand) knownSet.add(c);

  // Cards whose location is unknown to the actor: the deck minus everything
  // played (location now public) and minus the hands the actor can see.
  const unknown = know.deck.filter((c) => !playedSet.has(c) && !knownSet.has(c));
  const hiddenSeats = ([0, 1, 2, 3] as Seat[]).filter((s) => !know.knownHands.has(s));

  /** does `remaining` (a hidden seat's sampled unplayed cards) satisfy the seat's reqs at this ladder level? */
  const satisfies = (seat: Seat, remaining: Card[], level: number): boolean => {
    if (level >= 2) return true;
    // HCP/shape constraints describe the ORIGINAL hand; played cards are public.
    const original = [...remaining, ...know.playedBySeat[seat]];
    for (const c of constraints[seat]) {
      if (level === 1 && c.fromPass) continue;
      if (!satisfiesConstraint(original, c.req)) return false;
    }
    return true;
  };

  const drawOnce = (level: number): Map<Seat, Card[]> | null => {
    const pool = [...unknown];
    shuffleInPlace(pool, rng);
    const hands = greedyAssign(pool, hiddenSeats, know.remainingCounts, know.voids);
    if (!hands) return null;
    for (const seat of hiddenSeats) {
      if (!satisfies(seat, hands.get(seat)!, level)) return null;
    }
    return hands;
  };

  const ladder: { level: number; tries: number }[] = [
    { level: 0, tries: SAMPLER.TRIES_FULL },
    { level: 1, tries: SAMPLER.TRIES_NO_PASS },
    { level: 2, tries: SAMPLER.TRIES_VOIDS_ONLY },
  ];

  const layouts = new Map<string, WeightedLayout>();
  for (let sample = 0; sample < k; sample++) {
    let hands: Map<Seat, Card[]> | null = null;
    for (const { level, tries } of ladder) {
      for (let t = 0; t < tries && !hands; t++) hands = drawOnce(level);
      if (hands) break;
    }
    if (!hands) {
      // Voids-only greedy kept stranding a seat — fall back to an exact
      // void-respecting assignment of one final shuffle (always feasible:
      // the true deal is a witness).
      const pool = [...unknown];
      shuffleInPlace(pool, rng);
      hands = backtrackAssign(pool, hiddenSeats, know.remainingCounts, know.voids);
    }

    // Reconstruct full ORIGINAL hands (sampled remaining ∪ played) so the
    // layout is a normal Deal that remainingCards()/buildSolveRequest accept.
    const fullHands: Card[][] = [0, 1, 2, 3].map((seat) => {
      const original = know.knownHands.has(seat as Seat)
        ? [...know.knownHands.get(seat as Seat)!]
        : [...hands!.get(seat as Seat)!, ...know.playedBySeat[seat]];
      return original.sort((a, b) => a - b);
    });
    const key = fullHands.map((h) => handToPbn(h)).join(' ');
    const existing = layouts.get(key);
    if (existing) existing.weight++;
    else {
      layouts.set(key, {
        deal: { hands: fullHands, dealer: know.dealer, vul: know.vul },
        weight: 1,
      });
    }
  }
  return [...layouts.values()];
}

/**
 * The seed string for one robot card decision:
 * `${tournamentSeed}#board${boardNo}#mc${plays.length}`. One seededRng stream
 * per decision covers every draw and rejection retry. Two players at the same
 * position necessarily share (seed, boardNo, plays), so they get the same
 * stream and the same card — the duplicate-fairness argument in one line.
 * plays.length strictly increases across a board's decisions, so no two
 * decisions share a stream.
 */
export function mcDecisionSeed(tournamentSeed: string, boardNo: number, playsLen: number): string {
  return `${tournamentSeed}#board${boardNo}#mc${playsLen}`;
}

export interface SampledChooseOpts {
  /** sample count — the difficulty dial (see difficulty.ts) */
  k: number;
  /** from mcDecisionSeed() */
  seed: string;
  dealer: Seat;
  /** the completed auction, for hand constraints on hidden seats */
  calls: Call[];
  /**
   * When false, sampling ignores the auction entirely (no SAYC constraints
   * on hidden hands — only shown-out voids bind): the beginner tier's
   * "doesn't count HCP from the bidding" blindness. Default true.
   */
  useAuction?: boolean;
}

/**
 * Choose the acting robot's card by sampled double-dummy. Receives the true
 * deal (the server has it) but reads it only through deriveKnowledge — see
 * its docstring for the exact non-leak audit surface.
 */
export async function chooseCardSampled(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  opts: SampledChooseOpts,
): Promise<Card> {
  const state = playState(deal, contract, plays);
  const legal = legalCards(deal, state);
  if (legal.length === 0) throw new Error('no legal cards');
  if (legal.length === 1) return legal[0]; // forced — free at every difficulty, no rng consumed

  const know = deriveKnowledge(deal, contract, plays, opts.dealer, opts.calls);
  const constraints =
    opts.useAuction === false ? [[], [], [], []] : hoistAuctionConstraints(opts.dealer, opts.calls);
  const rng = seededRng(opts.seed);
  const layouts = sampleLayouts(know, constraints, Math.max(1, Math.floor(opts.k)), rng);

  // Integer totals summed per legal card: order-independent, so solving
  // layouts concurrently (worker pool) cannot change the result. Every legal
  // card belongs to the actor-visible hand on play, which every layout fixes
  // to its true cards, so DDS scores the full legal set in each solve.
  // Solves go through the worker pool when available (parallel across
  // threads, each with its own WASM instance); otherwise — or if the pool
  // degrades mid-flight — through the main-thread instance. DDS is
  // deterministic, so where a solve runs can never change the chosen card.
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
