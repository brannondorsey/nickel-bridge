import { Card, Contract, Deal, Seat, cardRank, cardSuit, playState, trickWinner, trumpSuit } from '@bridge/core';

/**
 * Is a position SETTLED no matter what anybody does?
 *
 * The auto-claim gate in server/src/game.ts used to ask double dummy whether
 * one side takes 100% of the remaining tricks, and fast-play the tail if so.
 * That is a claim about a minimax VALUE: it holds only if everyone keeps
 * playing correctly. Reaching it can still require an unblock, a cashing
 * order, or a discard — and the server was making those choices on the
 * player's behalf (and, at the weaker tiers, on behalf of robots that would
 * not have found them).
 *
 * This module answers the stronger question the gate actually wants: can ANY
 * legal card, played by ANY of the four seats, at ANY point in ANY
 * continuation, change the result? Only when the answer is no is the rest of
 * the hand genuinely a formality.
 *
 * The predicate is framed the way the gate is framed — "side C takes EVERY
 * remaining trick" — which makes it equivalent to something much easier to
 * search for: **the other side D never wins a single trick, in any line**. So
 * the search fails the instant a trick falls to D, and succeeds only by
 * exhausting the tree. There is no evaluation function anywhere in here; the
 * only judgment made is core's own `trickWinner`.
 *
 * Note what "any of the four seats" costs, because it is easy to under-read.
 * C's own two hands are adversaries too: a position also fails when one C
 * hand can win a trick, get stuck on lead, and have to lead into a D winner.
 * (Three tricks, notrump, South on lead, South ♠A♠K♠3 / North ♠Q♥2♥3 /
 * East ♠J♥A♥K / West ♠T♥Q♥J is a double-dummy laydown for N–S, but South may
 * legally lead the ♠3, North must win it with the ♠Q, and North then has
 * nothing but hearts to lead into East's ♥A.) What survives is close to "one
 * hand holds the rest outright", which is what a player means by a claim, and
 * it is a good deal rarer than the double-dummy gate firing.
 *
 * Three properties the callers rely on:
 *
 * - **Exact.** Every legal card of every seat is tried, modulo a
 *   rank-equivalence reduction that is proven sound below. Nothing here can
 *   answer `true` about a position that is not genuinely settled.
 * - **Deterministic.** Card iteration order is fixed, the transposition table
 *   is a visited set (so order-independent), and the bound is a NODE count
 *   rather than a clock. Every player on a board gets the same answer on
 *   every machine — invariant 1 in CONTRIBUTING.md.
 * - **Safe when it gives up.** Running out of budget reports `invariant:
 *   false`, i.e. no claim, i.e. the hand simply plays on. If the position
 *   really was settled, playing it out reaches the identical score anyway —
 *   all that is lost is the fast-forward, and the next decision node tries
 *   again against a strictly smaller tree. The budget is a pacing knob; it
 *   can never move a result.
 *
 * Pure and synchronous — no DDS, no model, no pool. Unusual for this package,
 * and deliberate: the gate calls it inside `advanceRobots` on the interactive
 * path, right after a solve it already paid for.
 */

/**
 * Nodes visited before the search gives up.
 *
 * Measured over 116 dealt-and-bid boards played double-dummy (951 gate nodes),
 * the value barely matters, which is the interesting part: at budgets of 5 k,
 * 10 k, 20 k, 50 k and 2 M the gate claimed on the SAME 77 boards, each
 * averaging 3.01 tricks fast-forwarded, with no check anywhere near the bound
 * (the most expensive proof took 3 121 nodes and the most expensive refutation
 * 2 136). Nothing in that corpus needs even 5 k; the budget is there for the
 * position the corpus didn't contain.
 *
 * It is also cheap to be wrong about, because deferral is self-healing: a
 * position abandoned for cost at one ply is re-checked at the next against a
 * strictly smaller tree and proved there. So the budget's real job is a
 * latency ceiling, not a coverage decision.
 *
 * 10 000 is twice the point where the outcome saturates: ~6 ms worst case and
 * ~0.6 ms of total search per board, against the endgame DD solve the gate has
 * already paid for at this node. Typical checks are far below that — p50 6
 * nodes for a position that isn't settled (it aborts at the first trick the
 * other side steals) and 24 for one that is.
 *
 * Raising or lowering this can change which positions claim, so it is a
 * deliberate robot change under invariant 1 — as are the fast paths and the
 * move ordering below, for the same reason.
 */
export const CLAIM_NODE_BUDGET = 10_000;

export interface InvarianceResult {
  /**
   * PROVEN: no legal card by any seat, in any continuation, lets the other
   * side win a trick. False means either disproven or unproven — see
   * `budgetExceeded`; the caller treats both the same way (don't claim).
   */
  invariant: boolean;
  /** nodes visited — deterministic, so tests may assert on it */
  nodes: number;
  /** the search was cut short; `invariant` is false but NOT disproven */
  budgetExceeded: boolean;
  /** what settled the ROOT: a fast path, the search, or nothing */
  via: 'cut-a' | 'cut-b' | 'search' | null;
}

export interface InvarianceOptions {
  budget?: number;
  /**
   * Rank-equivalence collapsing (default on). Test-only kill switch: a bug
   * here is precisely the "wrongly says settled" failure mode, so
   * claim.test.ts asserts collapsed and uncollapsed searches agree.
   */
  collapse?: boolean;
  /** The O(52) fast paths (default on). Test-only kill switch, same reason. */
  cuts?: boolean;
}

const LOW_RANK = [0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0]; // ctz for a nibble

/** rank of the lowest set bit in a 13-bit rank mask (mask must be non-zero) */
function lowestRank(mask: number): number {
  let r = 0;
  while ((mask & 0xf) === 0) {
    mask >>= 4;
    r += 4;
  }
  return r + LOW_RANK[mask & 0xf];
}

/** rank of the highest set bit in a 13-bit rank mask (mask must be non-zero) */
function highestRank(mask: number): number {
  let r = 0;
  while (mask > 1) {
    mask >>= 1;
    r++;
  }
  return r;
}

/**
 * Does `claimingSide` (0 = N/S, 1 = E/W) win EVERY remaining trick under
 * EVERY legal continuation by ALL FOUR seats?
 *
 * `plays` is the board's play history so far, exactly as `game.ts` holds it;
 * the position searched is the one after those cards, including a trick left
 * part-played (its cards are history, but the trick has no winner yet, so it
 * counts among the remaining tricks — the same accounting the gate's
 * `13 - completedTricks.length` uses).
 *
 * `claimingSide` is passed in rather than re-derived because the caller
 * already holds the DD solve that names it.
 */
export function isOutcomeInvariant(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  claimingSide: 0 | 1,
  opts: InvarianceOptions = {},
): InvarianceResult {
  const budget = opts.budget ?? CLAIM_NODE_BUDGET;
  const collapse = opts.collapse !== false;
  const cutsOn = opts.cuts !== false;
  const trump = trumpSuit(contract.strain);

  // deal.hands is the full un-played-from deal, so its hand size is this
  // deal's total trick count — 13 for a real board, fewer for the hand-crafted
  // micro-deals the tests use. playState/legalCards hardcode 13 (a sound
  // assumption everywhere else in the codebase, which only ever sees full
  // deals), so this module tracks completion itself rather than trusting
  // PlayState.isOver.
  const totalTricks = deal.hands[0].length;

  // One PlayState at setup, then everything below is incremental: playState is
  // O(plays) and allocates, which at 10^4-10^5 nodes would dominate the search.
  const start = playState(deal, contract, plays);
  const played = new Set(plays);

  // hand[seat * 4 + suit] = 13-bit mask of the ranks that seat still holds.
  const hand = new Uint16Array(16);
  for (let s = 0; s < 4; s++) {
    for (const c of deal.hands[s]) {
      if (!played.has(c)) hand[s * 4 + cardSuit(c)] |= 1 << cardRank(c);
    }
  }

  // sunk[suit] = ranks that are permanently out of play, i.e. in a COMPLETED
  // trick. Cards sitting in the trick in progress are deliberately NOT here:
  // they are still contesting, and treating them as dead would corrupt the
  // equivalence test below.
  const sunk = new Uint16Array(4);
  for (const t of start.completedTricks) {
    for (const p of t) sunk[cardSuit(p.card)] |= 1 << cardRank(p.card);
  }

  // The trick in progress, stored PER DEPTH rather than in four reused slots.
  // A trick that completes hands the lead to a child which starts filling a
  // trick of its own; sharing one four-slot buffer would have that child
  // overwrite the cards its ancestors are still iterating around, and the
  // sibling branches would then be built on garbage. One region per trick
  // costs 14 tricks × 4 and makes the unwind a no-op.
  const trickSeat = new Int32Array(4 * 14);
  const trickCard = new Int32Array(4 * 14);
  // Preallocated objects for core's trickWinner, filled immediately before the
  // call and never retained — so the trick-comparison rule stays core's single
  // copy without allocating four objects per boundary.
  const trickView = [
    { seat: 0 as Seat, card: 0 },
    { seat: 0 as Seat, card: 0 },
    { seat: 0 as Seat, card: 0 },
    { seat: 0 as Seat, card: 0 },
  ];
  let depth = 0; // tricks completed since the search began
  let trickLen = start.currentTrick.length;
  for (let i = 0; i < trickLen; i++) {
    trickSeat[i] = start.currentTrick[i].seat;
    trickCard[i] = start.currentTrick[i].card;
  }
  let turn: Seat = start.handToPlay;
  let tricksLeft = totalTricks - start.completedTricks.length;

  let nodes = 0;
  let budgetExceeded = false;
  const proven = new Set<string>();

  /**
   * A position is identified by the four remaining holdings, the cards on the
   * table, and whose turn it is. Trump and the claiming side are fixed for the
   * whole search, and `sunk` is implied (everything not held and not on the
   * table). `turn` is redundant mid-trick but decisive at a boundary, where
   * two lines can leave the identical cards with a different player on lead —
   * omit it and the second is silently pruned as already-seen.
   */
  function key(): string {
    let k = '';
    for (let i = 0; i < 16; i++) k += hand[i].toString(36) + ',';
    k += '#';
    const base = depth * 4;
    for (let i = 0; i < trickLen; i++) k += trickSeat[base + i] + ':' + trickCard[base + i] + ',';
    return k + '#' + turn;
  }

  /**
   * One representative per rank-equivalence group. Two cards of a suit in the
   * SAME hand are interchangeable when every rank strictly between them is
   * sunk: swapping them relabels ranks in a way that preserves every order
   * comparison among cards still in play, so the two subtrees are isomorphic
   * and produce the same trick winners. Keep the lowest of each group, which
   * also matches pickFromSolve's lowest-first tie-break.
   */
  function representatives(mask: number, suit: number): number {
    if (!collapse) return mask;
    const dead = sunk[suit];
    let reps = 0;
    for (let r = 0; r < 13; r++) {
      if (!(mask & (1 << r))) continue;
      let q = r - 1;
      while (q >= 0 && dead & (1 << q)) q--;
      if (q >= 0 && mask & (1 << q)) continue; // equivalent to a lower card already offered
      reps |= 1 << r;
    }
    return reps;
  }

  /**
   * Sufficient conditions for "the leader simply runs the rest", checked only
   * with a claiming-side seat on lead. Each may only ever answer true.
   *
   * Cut A (notrump): every card the leader holds outranks every remaining card
   * of that suit held by any of the OTHER THREE seats — partner included.
   * Partner is the clause that is easy to drop and fatal to drop: leaving it
   * out blesses exactly the stuck-on-lead position in this module's header.
   * Whatever the leader leads, the others follow lower or discard, and a
   * discard cannot win at notrump; the leader wins and is on lead again with
   * the inequality intact, since both sides of it only shrink.
   *
   * Cut B (trump contract): the leader holds nothing but trumps, each above
   * every trump left anywhere else. Others follow with a lower trump or, being
   * void, discard something that cannot beat a trump. Same induction.
   *
   * The leader holds exactly `tricksLeft` cards and wins every trick, so
   * neither cut can run the leader out of cards early.
   *
   * These rarely settle the ROOT — at a gate node the claiming side is usually
   * mid-trick, or declarer and dummy split the winners between them — but they
   * fire constantly deeper in the tree, where one hand has been left holding
   * the rest. Measured over 60 boards they cut total nodes searched from
   * 48 309 to 19 272, and the worst single check from 19 203 nodes to 3 121.
   */
  function cutA(lead: Seat): boolean {
    if (trump !== null) return false;
    for (let u = 0; u < 4; u++) {
      const mine = hand[lead * 4 + u];
      if (mine === 0) continue;
      const others = hand[((lead + 1) % 4) * 4 + u] | hand[((lead + 2) % 4) * 4 + u] | hand[((lead + 3) % 4) * 4 + u];
      if (others !== 0 && lowestRank(mine) < highestRank(others)) return false;
    }
    return true;
  }

  function cutB(lead: Seat): boolean {
    if (trump === null) return false;
    for (let u = 0; u < 4; u++) {
      if (u !== trump && hand[lead * 4 + u] !== 0) return false;
    }
    const mine = hand[lead * 4 + trump];
    if (mine === 0) return false;
    const others =
      hand[((lead + 1) % 4) * 4 + trump] | hand[((lead + 2) % 4) * 4 + trump] | hand[((lead + 3) % 4) * 4 + trump];
    return others === 0 || lowestRank(mine) > highestRank(others);
  }

  /** True ⇒ the other side wins no trick anywhere below this node. */
  function search(): boolean {
    if (++nodes > budget) {
      budgetExceeded = true;
      return false;
    }
    if (tricksLeft === 0) return true;
    if (trickLen === 0 && cutsOn && turn % 2 === claimingSide && (cutA(turn) || cutB(turn))) return true;
    const k = key();
    if (proven.has(k)) return true;

    const seat = turn;
    const base = seat * 4;
    const slot = depth * 4;
    let suits: number;
    if (trickLen === 0) {
      suits = 0b1111;
    } else {
      const led = cardSuit(trickCard[slot]);
      suits = hand[base + led] !== 0 ? 1 << led : 0b1111;
    }

    // Move ordering, speed only: the side being denied tries its strongest
    // cards first and the claiming side its weakest, so a position that ISN'T
    // settled produces its counterexample as early as possible. Fixed and
    // deterministic either way.
    const denied = seat % 2 !== claimingSide;

    for (let u = 0; u < 4; u++) {
      if (!(suits & (1 << u))) continue;
      const mask = hand[base + u];
      if (mask === 0) continue;
      const reps = representatives(mask, u);
      for (let i = 0; i < 13; i++) {
        const r = denied ? 12 - i : i;
        if (!(reps & (1 << r))) continue;

        // play it
        hand[base + u] = mask & ~(1 << r);
        trickSeat[slot + trickLen] = seat;
        trickCard[slot + trickLen] = u * 13 + r;
        trickLen++;

        let ok: boolean;
        const prevTurn = turn;
        if (trickLen === 4) {
          for (let j = 0; j < 4; j++) {
            trickView[j].seat = trickSeat[slot + j] as Seat;
            trickView[j].card = trickCard[slot + j];
          }
          const winner = trickWinner(trickView, contract.strain);
          if (winner % 2 !== claimingSide) {
            // A trick fell to the other side: the outcome is not settled, and
            // no amount of further searching can un-find this line.
            trickLen--;
            hand[base + u] = mask;
            return false;
          }
          for (let j = 0; j < 4; j++) sunk[cardSuit(trickCard[slot + j])] |= 1 << cardRank(trickCard[slot + j]);
          turn = winner;
          trickLen = 0;
          tricksLeft--;
          depth++;
          ok = search();
          depth--;
          tricksLeft++;
          trickLen = 4;
          for (let j = 0; j < 4; j++) sunk[cardSuit(trickCard[slot + j])] &= ~(1 << cardRank(trickCard[slot + j]));
        } else {
          turn = ((seat + 1) % 4) as Seat;
          ok = search();
        }
        turn = prevTurn;

        // undo
        trickLen--;
        hand[base + u] = mask;
        if (!ok) return false;
      }
    }
    proven.add(k);
    return true;
  }

  // The root's fast paths are reported separately so tests can tell which
  // mechanism settled a position; inside the tree they are pure speed.
  if (cutsOn && tricksLeft > 0 && trickLen === 0 && turn % 2 === claimingSide) {
    if (cutA(turn)) return { invariant: true, nodes: 0, budgetExceeded: false, via: 'cut-a' };
    if (cutB(turn)) return { invariant: true, nodes: 0, budgetExceeded: false, via: 'cut-b' };
  }
  const invariant = search();
  return { invariant, nodes, budgetExceeded, via: invariant ? 'search' : null };
}
