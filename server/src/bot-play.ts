import { seededRng } from '@bridge/core';
import { TournamentRow, db } from './db.js';
import { boardView, ensureAdvanced, loadBoard, submitCall, submitPlay } from './game.js';

/**
 * Deterministic bot-driven board play, shared by the ambient demo seeder
 * (demo-seed.ts) and the "reveal a whole tournament" exhibit path (demo.ts).
 * Both need the same "resume tolerant of an interrupted prior attempt"
 * property — a half-played board resumes with a restarted rng stream and
 * would complete differently than an uninterrupted run — so it lives in one
 * place instead of two copies that could drift apart.
 */

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const stmtDoneCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
// A half-played board resumes with a restarted rng stream and would complete
// differently than an uninterrupted run — wipe it and replay from scratch so
// interrupted seeds stay deterministic.
const stmtDeleteUnfinished = db.prepare(
  `DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND state != 'done'`,
);

/**
 * Play one board to completion as `userId` with a deterministic, slightly
 * erratic strategy: mostly passes with the occasional low bid (spreads bid
 * grades across the whole excellent→poor range) and rng-chosen legal cards
 * (spreads scores so matchpoint fields aren't all ties). Yields the event
 * loop after every action — the DDS solves inside each submit are
 * synchronous WASM, so this is what keeps /health and live requests
 * responsive while bots play.
 */
async function playBoard(t: TournamentRow, userId: number, boardNo: number, rng: () => number): Promise<void> {
  const b = loadBoard(t, userId, boardNo, true)!;
  await ensureAdvanced(b);
  let view = boardView(t, b, 1200);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) {
      const legal = view.legalCalls as number[];
      const lowBids = legal.filter((c) => c >= 3 && c <= 17); // levels 1–3 only
      const call = lowBids.length && rng() < 0.25 ? lowBids[Math.floor(rng() * lowBids.length)] : 0;
      await submitCall(b, call);
    } else if (view.state === 'playing' && view.myTurn) {
      const cards = view.legalCards as number[];
      await submitPlay(b, cards[Math.floor(rng() * cards.length)]);
    } else {
      throw new Error(`seed stuck on ${t.seed} board ${boardNo}: ${view.state}`);
    }
    await tick();
    view = boardView(t, b, 1200);
  }
  if (safety <= 0) throw new Error(`seed runaway on ${t.seed} board ${boardNo}`);
}

/**
 * Get `userId` through boards 1..uptoNo of tournament `t`, resuming from
 * however many are already done and wiping any unfinished attempt first (see
 * playBoard's docstring on why an interrupted board can't just continue).
 * `rngKey(boardNo)` names the deterministic rng stream for that board — the
 * ambient seeder and the exhibit runner key it differently (per-player vs.
 * per-exhibit) but share this loop.
 */
export async function playThrough(
  t: TournamentRow,
  userId: number,
  uptoNo: number,
  rngKey: (boardNo: number) => string,
): Promise<void> {
  stmtDeleteUnfinished.run(t.id, userId);
  const done = (stmtDoneCount.get(t.id, userId) as { n: number }).n;
  for (let no = done + 1; no <= uptoNo; no++) {
    await playBoard(t, userId, no, seededRng(rngKey(no)));
  }
}
