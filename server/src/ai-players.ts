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
import { BoardStrategy, playSingleBoard } from './bot-play.js';
import { GameBoard, bidder } from './game.js';
import { getTournament } from './tournaments.js';

/**
 * Benchmark AI players — "the house": three permanent personas ("The Novice",
 * "The Regular", "The Shark") that automatically play every
 * tournament stamped `ai_field = 1` (placeUser's creation path and
 * demo-seed's ambient tournaments). They are FULL FIELD MEMBERS in
 * matchpointing: standings/boardResult/myBoardSummaries score everyone in
 * one field, so house rows earn real ranks, count as pairs, and move human
 * pcts like any other pair would — beating The Shark is worth matchpoints.
 * The persona/human split survives in exactly three places: Elo (personas
 * never rate, and the replay's inputs are human-only pcts — eloParticipants
 * in tournaments.ts — so house play can't shape a human rating even
 * indirectly; their completions skip the replay), placement (grace/popularity
 * counts are human-only, or every fresh tournament would be closed and
 * boosted by the house within a minute), and the Elo leaderboard.
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
 * (playSingleBoard wipes an unfinished attempt — which is also what prevents
 * duplicated bid_evals on resume).
 *
 * SCHEDULING — deferrable background work, except where a human is waiting.
 * Persona play is CPU-heavy (DDS solves), and on small machines an eager
 * backlog visibly lags live players (measured: 1.3-1.9s card taps on a
 * single unthrottled core, and on Fly's shared CPUs it burns the burst-quota
 * budget outright — see docs in the PR). So work is split into UNITS (one
 * persona × one board, board-major order) drained by a single runner:
 *
 *   - URGENT units run immediately: boards a recently-active human in that
 *     tournament will need within LOOKAHEAD_BOARDS of their own progress.
 *     One board-number across all three personas costs ~15-60s of compute
 *     vs the minutes a human spends on a board, so the house scores for
 *     board N are always in place before a human finishes board N — the
 *     "how did I rank against the house?" moment never waits.
 *   - Everything else (other tournaments, boards beyond the lookahead)
 *     PAUSES while any interactive API request was seen within PAUSE_MS,
 *     and resumes full-speed when the app goes quiet. Urgent units are
 *     re-evaluated every iteration, so a human landing in a new tournament
 *     jumps its units ahead of a parked backlog instantly.
 *
 * Nothing here races the engine: units for the same tournament run strictly
 * sequentially (one runner), and a unit is the atomic grain — suspension
 * (demo wipe) waits out at most one board, not a whole tournament. Play for
 * a tournament starts on demand — placement or a board GET with ai_field=1
 * enqueues it — and the boot sweep re-enqueues only tournaments whose
 * persona play already STARTED but didn't finish (crash recovery), so demo
 * boot never grinds through ambient tournaments nobody has opened.
 * AI_PLAYERS=0 disables enqueueing and the sweep (the server test harness
 * sets it); AI_PAUSE_MS tunes the interactive-quiet window (tests set 0).
 */

export const AI_PLAYER_HANDLES: Record<SettableDifficulty, string> = {
  beginner: 'The Novice',
  intermediate: 'The Regular',
  expert: 'The Shark',
};

/** Personas stay this many boards ahead of the furthest human in an active tournament. */
export const LOOKAHEAD_BOARDS = 2;
/** A tournament counts as "a human is playing" for this long after their last board request. */
const TOURNAMENT_ACTIVE_MS = 10 * 60_000;

const pauseMs = (): number => Number(process.env.AI_PAUSE_MS ?? 15_000);

export function aiPlayersEnabled(): boolean {
  return process.env.AI_PLAYERS !== '0';
}

const stmtSetKindAi = db.prepare(`UPDATE users SET kind = 'ai' WHERE id = ?`);
// Boot-sweep scope: persona play STARTED (any AI board row, finished or not)
// but incomplete. Tournaments no human ever opened have no AI rows and are
// deliberately never swept — their play starts on demand.
const stmtAiFieldStartedIncomplete = db.prepare(
  `SELECT t.id FROM tournaments t
   WHERE t.ai_field = 1
     AND EXISTS (SELECT 1 FROM boards b JOIN users u ON u.id = b.user_id
                 WHERE b.tournament_id = t.id AND u.kind = 'ai')
     AND (SELECT COUNT(*) FROM boards b JOIN users u ON u.id = b.user_id
          WHERE b.tournament_id = t.id AND u.kind = 'ai' AND b.state = 'done') < ?
   ORDER BY t.id`,
);
// Placeholder count follows DIFFICULTIES.length so this stays correct if a
// tier is ever added or removed, instead of hardcoding today's count of 3.
const stmtPersonaBoardStates = db.prepare(
  `SELECT b.user_id, b.board_no FROM boards b
   WHERE b.tournament_id = ? AND b.user_id IN (${DIFFICULTIES.map(() => '?').join(', ')}) AND b.state = 'done'`,
);
// The furthest any human has progressed: their next board is MAX(done)+1.
const stmtMaxHumanDone = db.prepare(
  `SELECT COALESCE(MAX(done), 0) AS n FROM (
     SELECT COUNT(*) AS done FROM boards b JOIN users u ON u.id = b.user_id AND u.kind = 'human'
     WHERE b.tournament_id = ? AND b.state = 'done' GROUP BY b.user_id)`,
);

/**
 * Idempotently create (or fetch) the three personas. Handles are claimed
 * with a numeric suffix on collision (a human may already hold "The Novice"
 * — their handle is never touched). The claim also re-runs when a persona's
 * stored handle no longer starts with its configured name, so renaming a
 * persona in AI_PLAYER_HANDLES migrates existing databases on the next
 * ensure. Re-run wherever the personas might be missing: at boot, per
 * scheduler unit (demo reset wipes the users table), and from the demo
 * reseed path.
 */
export function ensureAiPlayers(): Record<SettableDifficulty, UserRow> {
  const out = {} as Record<SettableDifficulty, UserRow>;
  for (const tier of DIFFICULTIES) {
    const base = AI_PLAYER_HANDLES[tier];
    let user = upsertGoogleUser(`ai:${tier}`, null, base, null);
    stmtSetKindAi.run(user.id);
    for (let i = 0; i < 50 && !user.handle?.startsWith(base); i++) {
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
    call: async (b: GameBoard) => {
      await courtesyGap();
      return bidder.chooseCall(b.deal, b.calls, {
        difficulty: tier,
        seed: bidDecisionSeed(seedBase, b.row.board_no, b.calls.length),
      });
    },
    card: async (b: GameBoard) => {
      await courtesyGap();
      return chooseCardSampled(b.deal, b.contract!, b.plays, {
        k: MC_SAMPLES[tier].kOpp,
        useAuction: MC_SAMPLES[tier].auctionAware,
        playTopN: PLAY_NOISE[tier].topN,
        seed: mcDecisionSeed(seedBase, b.row.board_no, b.plays.length),
        dealer: b.deal.dealer,
        calls: b.calls,
      });
    },
  };
}

// ---- interactive-activity signals (fed by app.ts) ----

let lastInteractiveAt = 0;
const tournamentActiveAt = new Map<number, number>();

/** Any interactive API request — parks non-urgent persona work for PAUSE_MS. */
export function noteInteractiveRequest(): void {
  lastInteractiveAt = Date.now();
}

/** A human touched this tournament (placement or a board request) — its lookahead window is live. */
export function noteTournamentActivity(tournamentId: number): void {
  lastInteractiveAt = Date.now();
  tournamentActiveAt.set(tournamentId, Date.now());
}

const interactiveRecently = (): boolean => Date.now() - lastInteractiveAt < pauseMs();
const tournamentActive = (id: number): boolean =>
  Date.now() - (tournamentActiveAt.get(id) ?? 0) < TOURNAMENT_ACTIVE_MS;

/**
 * Decision-level courtesy: even URGENT units step out of the way of a human
 * who is actively tapping. Before each persona decision, wait for a short
 * interactive-quiet gap — a human's taps arrive seconds apart (thinking
 * time), so personas do their solving inside those gaps instead of racing
 * the taps for the DDS pool (measured: ~750ms p95 taps on one core without
 * this). The cap bounds starvation from a constant request stream: worst
 * case a persona board slows to ~cap × decisions, still minutes ahead of a
 * human's pace through four boards. Disabled with the pause gate
 * (AI_PAUSE_MS=0 — tests hammer requests with no think time at all).
 */
const COURTESY_QUIET_MS = 1_500;
const COURTESY_CAP_MS = 6_000;
async function courtesyGap(): Promise<void> {
  if (pauseMs() <= 0) return;
  const start = Date.now();
  while (Date.now() - lastInteractiveAt < COURTESY_QUIET_MS && Date.now() - start < COURTESY_CAP_MS) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- the unit scheduler ----

interface Unit {
  tournamentId: number;
  boardNo: number;
  tier: SettableDifficulty;
  urgent: boolean;
}

/** Tournaments with (possibly) unplayed persona boards, in enqueue order. */
const pending = new Set<number>();
let runnerActive = false;
let suspendCount = 0;
let log: FastifyBaseLogger = console as unknown as FastifyBaseLogger;
let wakeRunner: (() => void) | null = null;
const drainWaiters: (() => void)[] = [];

function poke(): void {
  wakeRunner?.();
}

/** Sleep that a poke() can cut short — keeps urgent work from waiting out a park. */
function parkUntilPoked(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    wakeRunner = finish;
    function finish(): void {
      clearTimeout(timer);
      if (wakeRunner === finish) wakeRunner = null;
      resolve();
    }
  });
}

/**
 * Queue the personas for tournament `tournamentId` and make sure the runner
 * is going. Fire-and-forget and idempotent — the runner re-derives what is
 * left to play from the database on every iteration, so double enqueues and
 * already-finished tournaments cost one SELECT.
 */
export function enqueueAiField(tournamentId: number, reqLog: FastifyBaseLogger): void {
  if (!aiPlayersEnabled()) return;
  log = reqLog;
  pending.add(tournamentId);
  poke();
  if (!runnerActive) {
    runnerActive = true;
    void runner();
  }
}

/**
 * The next unit of work, or null when nothing is playable. Board-major
 * within a tournament (board 1 for all three personas, then board 2, …) so
 * partial progress is always "the boards humans reach first". Urgent units
 * (an interactively-active tournament, within LOOKAHEAD_BOARDS of the
 * furthest human's next board) are preferred across tournaments; otherwise
 * enqueue order (Set iteration preserves insertion).
 */
function nextUnit(personas: Record<SettableDifficulty, UserRow>): Unit | null {
  let fallback: Unit | null = null;
  for (const tournamentId of pending) {
    const t = getTournament(tournamentId);
    if (!t || !t.ai_field || t.kind !== 'standard') {
      pending.delete(tournamentId); // deleted by a demo wipe, or never eligible
      continue;
    }
    const ids = DIFFICULTIES.map((tier) => personas[tier].id);
    const doneRows = stmtPersonaBoardStates.all(tournamentId, ...ids) as { user_id: number; board_no: number }[];
    const done = new Set(doneRows.map((r) => `${r.user_id}:${r.board_no}`));
    let unit: Unit | null = null;
    for (let boardNo = 1; boardNo <= BOARDS_PER_TOURNAMENT && !unit; boardNo++) {
      for (const tier of DIFFICULTIES) {
        if (!done.has(`${personas[tier].id}:${boardNo}`)) {
          const maxHumanDone = (stmtMaxHumanDone.get(tournamentId) as { n: number }).n;
          const humanNext = Math.min(maxHumanDone + 1, BOARDS_PER_TOURNAMENT);
          const urgent = tournamentActive(tournamentId) && boardNo < humanNext + LOOKAHEAD_BOARDS;
          unit = { tournamentId, boardNo, tier, urgent };
          break;
        }
      }
    }
    if (!unit) {
      pending.delete(tournamentId); // fully played
      continue;
    }
    if (unit.urgent) return unit;
    fallback = fallback ?? unit;
  }
  return fallback;
}

/**
 * The single runner: pick a unit, play it, repeat. Non-urgent units wait for
 * interactive quiet; suspension (demo wipe) parks the loop between units.
 * Unit failures drop the tournament from the queue (logged) — the next
 * placement or boot sweep re-adds it — so a poison board can't hot-loop.
 */
async function runner(): Promise<void> {
  try {
    for (;;) {
      // The whole iteration — not just playSingleBoard — is guarded: runner()
      // is always invoked fire-and-forget (`void runner()`), so an exception
      // escaping this loop (e.g. a transient synchronous-SQLite error inside
      // ensureAiPlayers/nextUnit, ahead of or outside the inner try below)
      // would become an unhandled promise rejection and, under Node's default
      // --unhandled-rejections=throw, crash the whole server — not just the
      // background feature. Drop everything queued and stop; the next
      // placement or boot sweep re-enqueues from a clean slate.
      try {
        if (suspendCount > 0) {
          await parkUntilPoked(1_000);
          continue;
        }
        if (pending.size === 0) break;
        const personas = ensureAiPlayers();
        const unit = nextUnit(personas);
        if (!unit) continue; // pending shrank inside nextUnit — re-check loop conditions
        if (!unit.urgent && interactiveRecently()) {
          // A human is around and nothing is urgent: park. A poke (new
          // enqueue / activity note) re-evaluates immediately.
          await parkUntilPoked(Math.max(1_000, pauseMs() / 3));
          continue;
        }
        const t = getTournament(unit.tournamentId)!;
        try {
          await playSingleBoard(t, personas[unit.tier].id, unit.boardNo, tierStrategy(unit.tier, t.seed));
        } catch (err) {
          log.error({ err, tournamentId: unit.tournamentId, boardNo: unit.boardNo, tier: unit.tier },
            'ai-players: unit failed; dropping tournament from queue');
          pending.delete(unit.tournamentId);
        }
      } catch (err) {
        log.error({ err }, 'ai-players: scheduler loop failed; suspending the queue');
        pending.clear();
        break;
      }
    }
  } finally {
    runnerActive = false;
    for (const w of drainWaiters.splice(0)) w();
    // work may have been enqueued while we were unwinding
    if (pending.size > 0 && suspendCount === 0 && aiPlayersEnabled()) {
      runnerActive = true;
      void runner();
    }
  }
}

/**
 * Resolves once the queue is fully drained (no pending tournaments, runner
 * parked). Test-harness API — production code never waits on the house.
 */
export function whenAiPlayersDrained(): Promise<void> {
  if (!runnerActive && pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    drainWaiters.push(() => {
      // drained only if nothing new arrived; otherwise re-arm
      if (!runnerActive && pending.size === 0) resolve();
      else void whenAiPlayersDrained().then(resolve);
    });
  });
}

/**
 * Run `fn` with persona play suspended — the runner finishes its current
 * unit and parks before `fn` runs. Demo's wipe/reseed uses this so the wipe
 * never deletes rows out from under a mid-board persona; it also clears the
 * queue, since the wipe deletes the queued tournaments themselves
 * (post-reseed enqueues repopulate it on demand). Bounded by at most one
 * board's worth of decisions, but NOT necessarily seconds: courtesyGap caps
 * each decision at COURTESY_CAP_MS (6s), and a board is ~15-20 decisions, so
 * under sustained interactive traffic from other concurrent testers the wait
 * can run to a couple of minutes worst case, not just seconds.
 */
export async function withAiPlayersSuspended<T>(fn: () => T | Promise<T>): Promise<T> {
  suspendCount++;
  try {
    await unitBoundary();
    pending.clear();
    return await fn();
  } finally {
    suspendCount--;
    poke();
  }
}

/** Resolves when the runner is not inside a unit (parked, waiting, or stopped). */
function unitBoundary(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      // Parked runners sit in parkUntilPoked with wakeRunner set; a stopped
      // runner has runnerActive false. Either way no unit is mid-flight.
      if (!runnerActive || wakeRunner !== null) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}

/**
 * Boot-time crash recovery (index.ts, after listen): re-enqueue tournaments
 * whose persona play started but didn't finish — a redeploy mid-board
 * resumes here. Tournaments nobody opened are untouched (on-demand start).
 */
export function sweepAiFields(bootLog: FastifyBaseLogger): void {
  if (!aiPlayersEnabled()) return;
  const target = DIFFICULTIES.length * BOARDS_PER_TOURNAMENT;
  for (const { id } of stmtAiFieldStartedIncomplete.all(target) as { id: number }[]) {
    enqueueAiField(id, bootLog);
  }
}
