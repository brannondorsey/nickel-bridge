import { BoardView, TrickCard } from '../api';
import { trickWinner } from '../components/game/playAnim';

/**
 * Synthetic BoardViews for the Analyze play lens: one locked, playing-state
 * view per ply of a FINISHED board, built purely from what the completed
 * board already shipped (allHands + playHistory + contract) — no server
 * round trip, no hidden information (everything here was revealed when the
 * board went 'done').
 *
 * views[p] is the position after p cards. Consecutive views differ by
 * exactly one card, which is what lets useReplay stage them through
 * stagePlaySteps (single-boundary assumption) and lets TrickArea's
 * prev-diff animation glide each card in for free. Every view is an
 * absolute snapshot (remaining hands recomputed per ply), so cutting to an
 * arbitrary index is always safe.
 */
export function buildReplayViews(base: BoardView): BoardView[] {
  if (!base.contract || !base.allHands || !base.playHistory) return [];
  const strain = base.contract.strain;
  const flat: TrickCard[] = base.playHistory.flat();
  const playingSeat = base.playingSeat ?? (base.flipped ? 0 : 2);
  const dummy = base.dummy;

  const views: BoardView[] = [];
  for (let p = 0; p <= flat.length; p++) {
    const played = new Set(flat.slice(0, p).map((t) => t.card));
    const completed: TrickCard[][] = [];
    let current: TrickCard[] = [];
    for (let i = 0; i < p; i++) {
      current.push(flat[i]);
      if (current.length === 4) {
        completed.push(current);
        current = [];
      }
    }
    let declarerTricks = 0;
    for (const trick of completed) {
      const winner = trickWinner(trick, strain);
      if (winner % 2 === base.contract.declarer % 2) declarerTricks++;
    }
    const handToPlay = p < flat.length ? flat[p].seat : undefined;
    const remaining = (seat: number | undefined): number[] | undefined =>
      seat === undefined ? undefined : base.allHands![seat].filter((c) => !played.has(c));

    views.push({
      ...base,
      state: 'playing',
      myTurn: false,
      legalCalls: undefined,
      legalCards: undefined,
      result: undefined,
      claimed: undefined,
      hand: remaining(playingSeat)!,
      dummyHand: p >= 1 ? remaining(dummy) : undefined, // dummy faces up after the opening lead
      currentTrick: current,
      completedTricks: completed.length,
      lastTrick: completed.length ? completed[completed.length - 1] : null,
      declarerTricks,
      defenderTricks: completed.length - declarerTricks,
      handToPlay,
    });
  }
  return views;
}

/** first ply (views index) of a 1-based trick number */
export function firstPlyOfTrick(trick: number): number {
  return Math.max(0, (trick - 1) * 4);
}

/** 1-based trick number a views index falls in (the trick in progress at that ply) */
export function trickOfPly(ply: number, totalPlies: number): number {
  const capped = Math.min(ply, Math.max(0, totalPlies - 1));
  return Math.floor(capped / 4) + 1;
}
