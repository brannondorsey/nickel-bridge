import { Card, Contract, Deal, legalCards, playState, trickWinner } from '@bridge/core';

/**
 * The obviously-correct answer to "does `claimingSide` win every remaining
 * trick, whatever all four seats do?", against which the production search in
 * src/claim.ts is differentially tested.
 *
 * Deliberately naive and slow: it rebuilds a full PlayState at every node,
 * calls core's `legalCards` for every move, branches on EVERY legal card of
 * EVERY seat, and applies no rank-equivalence reduction and none of the
 * production search's fast paths. The point is that a reader can check it
 * against the rules of bridge by eye. It is only ever run on small positions.
 *
 * Its one concession to speed is a visited set, which is safe here for the
 * same reason it is in production: this is a pure AND-search that unwinds
 * globally on the first failure, so re-reaching a node without having failed
 * means its subtree was already explored clean.
 */
export function referenceInvariant(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  claimingSide: 0 | 1,
  /**
   * Hard stop, and the reason it exists: this function has none of the
   * production search's pruning, so a position that got a few tricks deeper
   * than its caller expected doesn't merely get slow, it hangs the test until
   * vitest's default timeout and reports something opaque. Throwing names the
   * problem instead. Callers running against pinned real boards should pass
   * their own tripwire; the default suits the small crafted endings.
   */
  maxNodes = 200_000,
): boolean {
  // deal.hands is the un-played-from deal, so its hand size is this deal's
  // total trick count — 13 for a real board, fewer for a hand-crafted "last N
  // tricks" micro-deal. playState/legalCards hardcode 13, so track completion
  // here instead of trusting PlayState.isOver.
  const totalTricks = deal.hands[0].length;
  const seen = new Set<string>();
  let nodes = 0;

  function walk(current: Card[]): boolean {
    if (++nodes > maxNodes) {
      throw new Error(
        `referenceInvariant exceeded ${maxNodes} nodes — the position is deeper than this oracle can brute-force. ` +
          `Shrink the case, or raise the caller's tripwire deliberately.`,
      );
    }
    const state = playState(deal, contract, current);
    if (state.completedTricks.length === totalTricks) return true;

    // The four holdings, the cards on the table, and WHOSE TURN IT IS. The
    // last is the part that is easy to leave out and wrong to leave out: at a
    // trick boundary the table is empty, so two lines that leave the identical
    // cards with a different player on lead would collide.
    const played = new Set(current);
    const key =
      ([0, 1, 2, 3] as const)
        .map((s) =>
          deal.hands[s]
            .filter((c) => !played.has(c))
            .sort((a, b) => a - b)
            .join(','),
        )
        .join('|') +
      '#' +
      state.currentTrick.map((p) => `${p.seat}:${p.card}`).join(',') +
      '#' +
      state.handToPlay;
    if (seen.has(key)) return true;

    for (const c of legalCards(deal, state)) {
      const next = [...current, c];
      const after = playState(deal, contract, next);
      // A trick just completed: if it fell to the other side, the outcome was
      // never settled and no further search can un-find this line.
      if (after.completedTricks.length > state.completedTricks.length) {
        const trick = after.completedTricks[after.completedTricks.length - 1];
        if (trickWinner(trick, contract.strain) % 2 !== claimingSide) return false;
      }
      if (!walk(next)) return false;
    }
    seen.add(key);
    return true;
  }

  return walk(plays);
}
