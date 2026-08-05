/**
 * Medal tiers — a loyalty rail rewarding continuous play with a suit medal at
 * the 4th, 25th, 100th and 500th completed tournament. Pure and
 * dependency-free like the rest of this package: the caller supplies both
 * counts (a completed-tournament count and a completed-board count) and the
 * boards-per-tournament constant, since none of the three is a core game
 * rule — they live in server/src/stats.ts and server/src/db.ts.
 */

export type MedalSuit = 'c' | 'd' | 'h' | 's';

export interface MedalTier {
  suit: MedalSuit;
  /** tournaments completed to earn this medal */
  threshold: number;
}

export const MEDAL_TIERS: MedalTier[] = [
  { suit: 'c', threshold: 4 },
  { suit: 'd', threshold: 25 },
  { suit: 'h', threshold: 100 },
  { suit: 's', threshold: 500 },
];

export interface MedalProgress {
  /** suits already earned, in tier order */
  earned: MedalSuit[];
  /** the suit currently being worked toward; null once every tier is earned */
  target: MedalSuit | null;
  /**
   * 0-100, this tier's bar fill — driven by TOTAL completed boards
   * (including boards from a tournament still in progress), measured from
   * ZERO tournaments rather than from the previously-earned tier, so
   * crossing a threshold never resets the bar: a player who just earned the
   * club medal (4 tournaments = 16 boards) is already 16/100 = 16% of the
   * way to diamond (25 tournaments = 100 boards), not starting over. Capped
   * at 99 while the tier isn't actually earned yet, so the bar can never
   * read full next to a still-grey medal — see the doc comment on
   * `computeMedalProgress` for why the two counts can drift apart. `100`
   * once every tier is earned.
   */
  pct: number;
  /**
   * Tournaments still needed to earn `target` — an EXACT figure off
   * `tournamentsCompleted` (the authoritative count), never derived from
   * boards. `0` once every tier is earned.
   */
  tournamentsRemaining: number;
}

/**
 * `tournamentsCompleted` is the authoritative count — it alone decides which
 * medals are colored in and exactly how many tournaments remain. It must
 * come from a query that counts a tournament only once ALL of its boards are
 * done (see server/src/stats.ts's `completedTournamentCount`) — never from
 * `totalBoardsCompleted / boardsPerTournament`, which would overcount a
 * player with boards scattered across many still-open tournaments.
 *
 * `totalBoardsCompleted` only ever smooths the BAR — a player mid-way
 * through their 4th tournament sees it climb board by board, even though
 * the club medal itself doesn't color in until that 4th tournament actually
 * finishes. It's measured from ZERO, not from the previously-earned tier,
 * so the bar never resets at a crossing — see `MedalProgress.pct`'s doc
 * comment. Because the two counts can drift apart (many tournaments left
 * half-finished at once inflate boards without completing any of them),
 * `pct` is capped at 99 while the tier isn't actually earned — the one
 * defensive rule in the whole function, there because a full bar next to a
 * still-grey medal would read as a bug.
 */
export function computeMedalProgress(
  tournamentsCompleted: number,
  totalBoardsCompleted: number,
  boardsPerTournament: number,
): MedalProgress {
  const earned: MedalSuit[] = [];
  let targetIndex = -1;
  for (let i = 0; i < MEDAL_TIERS.length; i++) {
    if (tournamentsCompleted >= MEDAL_TIERS[i].threshold) {
      earned.push(MEDAL_TIERS[i].suit);
    } else if (targetIndex === -1) {
      targetIndex = i;
    }
  }

  if (targetIndex === -1) {
    return { earned, target: null, pct: 100, tournamentsRemaining: 0 };
  }

  const tier = MEDAL_TIERS[targetIndex];
  const targetBoards = tier.threshold * boardsPerTournament;
  const progressBoards = Math.min(Math.max(totalBoardsCompleted, 0), targetBoards);
  const pct = Math.min(Math.round((progressBoards / targetBoards) * 100), 99);
  const tournamentsRemaining = tier.threshold - tournamentsCompleted;

  return { earned, target: tier.suit, pct, tournamentsRemaining };
}
