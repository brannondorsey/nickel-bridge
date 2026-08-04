/**
 * The Home rail's medal progress — see packages/core/src/medals.ts for the
 * tier math itself. This file only composes the two cheap counts
 * (`completedTournamentCount`, `completedBoardCount`, both in stats.ts) into
 * that pure function, and applies the same human-only gate Elo/placement
 * already use: AI house personas never earn or show medals, however many
 * tournaments they've churned through.
 *
 * `playerStats()` (stats.ts) computes a viewed profile's *earned* medals
 * inline instead of calling this — it already has `tournamentsCompleted`/
 * `boardsCompleted` in hand for whichever user is being viewed, so routing
 * through here would just be a second, redundant pair of queries.
 */
import { MedalProgress, computeMedalProgress } from '@bridge/core';
import { BOARDS_PER_TOURNAMENT } from './db.js';
import { completedBoardCount, completedTournamentCount } from './stats.js';

export function medalProgressFor(userId: number, kind: 'human' | 'ai'): MedalProgress | null {
  if (kind !== 'human') return null;
  const tournamentsCompleted = completedTournamentCount(userId, BOARDS_PER_TOURNAMENT);
  const totalBoardsCompleted = completedBoardCount(userId);
  return computeMedalProgress(tournamentsCompleted, totalBoardsCompleted, BOARDS_PER_TOURNAMENT);
}
