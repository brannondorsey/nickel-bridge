import { Call, Card, seededRng } from '@bridge/core';
import { TournamentRow, db } from './db.js';
import { GameBoard, boardView, ensureAdvanced, loadBoard, submitCall, submitPlay } from './game.js';

/**
 * Deterministic bot-driven board play, shared by the ambient demo seeder
 * (demo-seed.ts), the "reveal a whole tournament" exhibit path (demo.ts),
 * and the benchmark AI personas (ai-players.ts). All need the same "resume
 * tolerant of an interrupted prior attempt" property — a half-played board
 * resumes with a restarted decision stream and would complete differently
 * than an uninterrupted run — so the loop lives in one place instead of
 * copies that could drift apart. What differs is only HOW a caller decides
 * its calls and cards, injected as a BoardStrategy.
 */

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * One caller's decision policy for the acting user's turns. The strategy
 * receives the live GameBoard (it may need the un-redacted deal — boardView
 * redacts hidden hands) plus the legal actions from the current view, and
 * must return one of them. Two rules the shared loop enforces so strategies
 * don't have to: the view is re-read after every submit (a claim
 * fast-forward can consume the rest of the strategy's cards mid-response),
 * and turns are detected via view.myTurn — never seat assumptions (when
 * North declares, the acting user runs partner's hand).
 */
export interface BoardStrategy {
  call(b: GameBoard, legal: Call[]): Call | Promise<Call>;
  card(b: GameBoard, legal: Card[]): Card | Promise<Card>;
}

/**
 * The demo seeder's deliberately erratic strategy: mostly passes with the
 * occasional low bid (spreads bid grades across the whole excellent→poor
 * range) and rng-chosen legal cards (spreads scores so matchpoint fields
 * aren't all ties).
 */
export function erraticStrategy(rng: () => number): BoardStrategy {
  return {
    call(_b, legal) {
      const lowBids = legal.filter((c) => c >= 3 && c <= 17); // levels 1–3 only
      return lowBids.length && rng() < 0.25 ? lowBids[Math.floor(rng() * lowBids.length)] : 0;
    },
    card(_b, legal) {
      return legal[Math.floor(rng() * legal.length)];
    },
  };
}

/** erraticStrategy seeded from a stream key — the shape every demo caller uses. */
export function seededErraticStrategy(key: string): BoardStrategy {
  return erraticStrategy(seededRng(key));
}

const stmtDoneCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
// A half-played board resumes with a restarted decision stream and would
// complete differently than an uninterrupted run — wipe it and replay from
// scratch so interrupted runs stay deterministic (and never double-append
// bid_evals).
const stmtDeleteUnfinished = db.prepare(
  `DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND state != 'done'`,
);
const stmtDeleteUnfinishedBoard = db.prepare(
  `DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ? AND state != 'done'`,
);
const stmtBoardDone = db.prepare(
  `SELECT 1 FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ? AND state = 'done'`,
);

/**
 * Play exactly one board as `userId`, wiping any unfinished prior attempt at
 * THAT board first (same restart-determinism argument as stmtDeleteUnfinished,
 * scoped to one board — sound because a board's deal and decision streams
 * derive from (tournament seed, boardNo) alone, never from other boards).
 * No-op if the board is already done. This is the AI scheduler's unit of
 * work (ai-players.ts), which plays boards in board-major order rather than
 * playThrough's player-major sweep.
 */
export async function playSingleBoard(
  t: TournamentRow,
  userId: number,
  boardNo: number,
  strategy: BoardStrategy,
): Promise<void> {
  if (stmtBoardDone.get(t.id, userId, boardNo)) return;
  stmtDeleteUnfinishedBoard.run(t.id, userId, boardNo);
  await playBoard(t, userId, boardNo, strategy);
}

/**
 * Play one board to completion as `userId` using `strategy` for the acting
 * user's turns. Yields the event loop after every action — the DDS solves
 * inside each submit are synchronous WASM, so this is what keeps /health and
 * live requests responsive while bots play.
 */
async function playBoard(t: TournamentRow, userId: number, boardNo: number, strategy: BoardStrategy): Promise<void> {
  const b = loadBoard(t, userId, boardNo, true)!;
  await ensureAdvanced(b);
  let view = boardView(t, b, 1200);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) {
      await submitCall(b, await strategy.call(b, view.legalCalls as Call[]));
    } else if (view.state === 'playing' && view.myTurn) {
      await submitPlay(b, await strategy.card(b, view.legalCards as Card[]));
    } else {
      throw new Error(`bot stuck on ${t.seed} board ${boardNo}: ${view.state}`);
    }
    await tick();
    view = boardView(t, b, 1200);
  }
  if (safety <= 0) throw new Error(`bot runaway on ${t.seed} board ${boardNo}`);
}

/**
 * Get `userId` through boards 1..uptoNo of tournament `t`, resuming from
 * however many are already done and wiping any unfinished attempt first (see
 * stmtDeleteUnfinished on why an interrupted board can't just continue).
 * `strategyFor(boardNo)` supplies that board's decision policy — demo callers
 * seed an erratic rng per (player, board); the AI personas return their
 * seed-pure tier strategy.
 */
export async function playThrough(
  t: TournamentRow,
  userId: number,
  uptoNo: number,
  strategyFor: (boardNo: number) => BoardStrategy,
): Promise<void> {
  stmtDeleteUnfinished.run(t.id, userId);
  const done = (stmtDoneCount.get(t.id, userId) as { n: number }).n;
  for (let no = done + 1; no <= uptoNo; no++) {
    await playBoard(t, userId, no, strategyFor(no));
  }
}
