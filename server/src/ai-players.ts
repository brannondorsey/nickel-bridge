import {
  DIFFICULTIES,
  MC_SAMPLES,
  PLAY_NOISE,
  SettableDifficulty,
  bidDecisionSeed,
  chooseCardSampled,
  mcDecisionSeed,
} from '@bridge/ai';
import type { FastifyBaseLogger } from 'fastify';
import { claimHandle, upsertGoogleUser } from './auth.js';
import { BOARDS_PER_TOURNAMENT, UserRow, db } from './db.js';
import { BoardStrategy, playThrough } from './bot-play.js';
import { GameBoard, bidder } from './game.js';
import { getTournament } from './tournaments.js';

/**
 * Benchmark AI players — "the house": three permanent personas ("A Beginner",
 * "An Intermediate Player", "An Expert") that automatically play every
 * tournament stamped `ai_field = 1` at creation (placeUser and demo-seed's
 * ambient tournaments; never backfilled). Their scores surface in The Field
 * as SHADOW rows — reference points that let a human see where they sit
 * against known skill levels — and are guaranteed never to move a human
 * number: standings/boardResult/myBoardSummaries matchpoint humans among
 * humans only, recomputeElo filters them out (and their completions skip the
 * replay entirely), and placement/leaderboard/stats exclude kind='ai'.
 *
 * A persona plays the human seat through the real engine (bot-play.ts →
 * submitCall/submitPlay/advanceRobots), so its robot opponents are the
 * BOARD's difficulty exactly as any human's would be (invariant 1). The
 * persona's tier governs only its own decisions, and carries every dial that
 * defines a tier (difficulty.ts): BID_NOISE via chooseCall's difficulty opt,
 * belief quality (MC_SAMPLES.kOpp), auction-blindness (auctionAware), and
 * card-selection noise (PLAY_NOISE). Deliberately NOT applied: the kPartner
 * floor — that floor belongs to the robot partner. When a persona defends,
 * robot North plays at PARTNER_FLOOR just like a human's partner does, so
 * persona scores stay apples-to-apples with the human experience ("a player
 * of tier X in your chair"), expert-partner boon included.
 *
 * Decisions are seed-pure under a persona-namespaced stream
 * (`${t.seed}:ai:${tier}`) that can never alias the robots' own
 * bidDecisionSeed/mcDecisionSeed streams, so every human sees identical
 * benchmark scores and an interrupted board replays byte-identically
 * (playThrough wipes unfinished attempts — which is also what prevents
 * duplicated bid_evals on resume).
 *
 * All play runs on one serialized promise queue (the demo-seed pattern),
 * fire-and-forget behind the placement response, yielding the event loop per
 * action. AI_PLAYERS=0 disables enqueueing and the boot sweep — set by the
 * server test harness so suites that exercise placeUser don't spend minutes
 * playing benchmark boards.
 */

export const AI_PLAYER_HANDLES: Record<SettableDifficulty, string> = {
  beginner: 'A Beginner',
  intermediate: 'An Intermediate Player',
  expert: 'An Expert',
};

export function aiPlayersEnabled(): boolean {
  return process.env.AI_PLAYERS !== '0';
}

const stmtSetKindAi = db.prepare(`UPDATE users SET kind = 'ai' WHERE id = ?`);
// AI board-row coverage of one tournament, for the boot sweep's "incomplete"
// check. Counting done boards across all three personas against the 3×4
// target is exact because playThrough is the only writer of persona boards
// and never plays past BOARDS_PER_TOURNAMENT.
const stmtAiFieldIncomplete = db.prepare(
  `SELECT t.id FROM tournaments t
   WHERE t.ai_field = 1
     AND (SELECT COUNT(*) FROM boards b JOIN users u ON u.id = b.user_id
          WHERE b.tournament_id = t.id AND u.kind = 'ai' AND b.state = 'done') < ?
   ORDER BY t.id`,
);

/**
 * Idempotently create (or fetch) the three personas. Handles are claimed
 * with a numeric suffix on collision (a human may already hold "A Beginner"
 * — their handle is never touched). Re-run wherever the personas might be
 * missing: at boot, at the head of every queued play task (demo reset wipes
 * the users table), and from the demo reseed path.
 */
export function ensureAiPlayers(): Record<SettableDifficulty, UserRow> {
  const out = {} as Record<SettableDifficulty, UserRow>;
  for (const tier of DIFFICULTIES) {
    const base = AI_PLAYER_HANDLES[tier];
    let user = upsertGoogleUser(`ai:${tier}`, null, base, null);
    stmtSetKindAi.run(user.id);
    for (let i = 0; i < 50 && !user.handle; i++) {
      user = claimHandle(user.id, i === 0 ? base : `${base} ${i + 1}`) ?? user;
    }
    out[tier] = { ...user, kind: 'ai' };
  }
  return out;
}

/**
 * A tier's decision policy for the persona's own seats (South, plus North's
 * cards whenever N-S declares — bot-play keys off view.myTurn, so the flip
 * is handled by the engine's humanControls, same as for a human).
 */
function tierStrategy(tier: SettableDifficulty, tournamentSeed: string): BoardStrategy {
  const seedBase = `${tournamentSeed}:ai:${tier}`;
  return {
    call: (b: GameBoard) =>
      bidder.chooseCall(b.deal, b.calls, {
        difficulty: tier,
        seed: bidDecisionSeed(seedBase, b.row.board_no, b.calls.length),
      }),
    card: (b: GameBoard) =>
      chooseCardSampled(b.deal, b.contract!, b.plays, {
        k: MC_SAMPLES[tier].kOpp,
        useAuction: MC_SAMPLES[tier].auctionAware,
        playTopN: PLAY_NOISE[tier].topN,
        seed: mcDecisionSeed(seedBase, b.row.board_no, b.plays.length),
        dealer: b.deal.dealer,
        calls: b.calls,
      }),
  };
}

let queue: Promise<void> = Promise.resolve();

/** One queue for every persona play task: runs never interleave with each other. */
function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Resolves once every task enqueued so far has settled. Demo reset awaits
 * this before wiping, so a wipe never deletes rows out from under a
 * mid-board persona (tasks enqueued after the snapshot are covered by the
 * run-time existence re-check below instead).
 */
export function whenAiPlayersIdle(): Promise<void> {
  return queue;
}

/**
 * Queue the three personas through tournament `tournamentId`. Fire-and-forget
 * and idempotent: the task re-fetches the tournament at run time (it may
 * have been deleted by a demo reset, or already fully played — playThrough
 * resumes from the done count, so re-enqueueing costs one SELECT per
 * persona). Callers pass their request/boot logger for error reporting.
 */
export function enqueueAiField(tournamentId: number, log: FastifyBaseLogger): void {
  if (!aiPlayersEnabled()) return;
  enqueue(async () => {
    const t = getTournament(tournamentId);
    if (!t || !t.ai_field || t.kind !== 'standard') return;
    const personas = ensureAiPlayers();
    for (const tier of DIFFICULTIES) {
      const strategy = tierStrategy(tier, t.seed);
      await playThrough(t, personas[tier].id, BOARDS_PER_TOURNAMENT, () => strategy);
    }
  }).then(
    () => undefined,
    (err) => log.error({ err, tournamentId }, 'ai-players: tournament play failed'),
  );
}

/**
 * Boot-time crash recovery (index.ts, after listen): re-enqueue every marked
 * tournament whose persona coverage is incomplete — a redeploy mid-board
 * resumes here. Legacy tournaments are unmarked and never swept.
 */
export function sweepAiFields(log: FastifyBaseLogger): void {
  if (!aiPlayersEnabled()) return;
  const target = DIFFICULTIES.length * BOARDS_PER_TOURNAMENT;
  for (const { id } of stmtAiFieldIncomplete.all(target) as { id: number }[]) {
    enqueueAiField(id, log);
  }
}
