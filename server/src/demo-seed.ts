import { seededRng } from '@bridge/core';
import type { FastifyBaseLogger } from 'fastify';
import { upsertGoogleUser } from './auth.js';
import { BOARDS_PER_TOURNAMENT, TournamentRow, UserRow, db } from './db.js';
import { claimHandleWithSuffix, ensureDemoUser, ensureExhibitTournament } from './demo.js';
import { boardView, ensureAdvanced, loadBoard, submitCall, submitPlay } from './game.js';
import { SCENARIOS } from './scenarios.js';

/**
 * Demo-mode boot seeder (DEMO=1 only — this module is never even imported
 * elsewhere): fills a fresh preview database with enough genuine history
 * that the ambient surfaces read true at a glance — leaderboard with rated
 * players, tournaments across every placement tier, populated stats pages,
 * matchpoint fields to compare against.
 *
 * Everything is played through the REAL engine (submitCall/submitPlay), not
 * fabricated rows: bid grades, contracts, claims, Elo, and accuracy series
 * only exist when the engine produces them (see stats.ts). The only direct
 * writes are timestamps — tournaments and bot accounts are backdated at
 * creation and board updated_at is aligned to the tournament's age — which
 * shifts *when* things appear to have happened, never *what* happened.
 *
 * Deterministic: bot strategies draw from an rng seeded per (bot,
 * tournament, board), and a board interrupted mid-play is wiped and replayed
 * from scratch on resume, so reseeding a wiped volume reproduces identical
 * data.
 *
 * Runs fire-and-forget after listen (index.ts) with an event-loop yield
 * after every action, so /health stays responsive between the synchronous
 * DDS solves. Idempotent: every step is check-before-create, so reruns
 * no-op cheaply and a crashed or reset-interrupted half-seed self-heals on
 * the next run. All entry points (seedDemo, wipeDemoData) go through one
 * queue, so a reset's wipe waits out an in-flight seed instead of yanking
 * rows from under it.
 */

export interface SeedProfile {
  /** bot display names; handles are claimed as-is */
  bots: string[];
  tournaments: {
    /** deterministic deal seed; doubles as the idempotence lookup key */
    seed: string;
    /** backdated age, seconds before now */
    ageS: number;
    /** indexes into `bots` for who plays here */
    players: number[];
    /** the Inspector plays too (their stats/tolls-paid need history) */
    inspector?: boolean;
    /** boards each player completes; 0 = start board 1 and leave it live */
    boards?: number;
  }[];
  /** pre-play fieldBots through scenario boards (scenarios.ts) */
  exhibitFields?: boolean;
}

/**
 * Ages are chosen to exercise every placement tier (tournaments.ts):
 * A is archived (> 30d) yet still rated; B and D are scoring-tier joins of
 * different decay; E sits inside the 48h grace window with < 4 starters, so
 * a tester's first PLAY THE TOLL force-joins it and meets a live field.
 */
export const DEFAULT_PROFILE: SeedProfile = {
  bots: ['Margaret', 'Walter', 'Edith', 'Harold', 'Pearl', 'Clarence'],
  tournaments: [
    { seed: 'demo-ambient-a', ageS: 35 * 86400, players: [0, 1, 2], inspector: true },
    { seed: 'demo-ambient-b', ageS: 20 * 86400, players: [3, 4] },
    { seed: 'demo-ambient-c', ageS: 10 * 86400, players: [1, 2, 5], inspector: true },
    { seed: 'demo-ambient-d', ageS: 2 * 86400, players: [0, 3] },
    { seed: 'demo-ambient-e', ageS: 6 * 3600, players: [4], boards: 0 },
  ],
  exhibitFields: true,
};

/** Seeded accounts predate the oldest seeded tournament ("Learning since"). */
const USER_AGE_S = 40 * 86400;

const stmtTournamentBySeed = db.prepare(`SELECT * FROM tournaments WHERE seed = ?`);
const stmtInsertBackdated = db.prepare(
  `INSERT INTO tournaments (name, seed, created_at) VALUES ('Tournament', ?, ?) RETURNING *`,
);
const stmtRename = db.prepare(`UPDATE tournaments SET name = ? WHERE id = ?`);
const stmtDoneCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
const stmtBoardExists = db.prepare(
  `SELECT 1 FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`,
);
// A half-played board resumes with a restarted rng stream and would complete
// differently than an uninterrupted run — wipe it and replay from scratch so
// interrupted seeds stay deterministic.
const stmtDeleteUnfinished = db.prepare(
  `DELETE FROM boards WHERE tournament_id = ? AND user_id = ? AND state != 'done'`,
);
const stmtBackdateBoards = db.prepare(`UPDATE boards SET updated_at = ? WHERE tournament_id = ? AND user_id = ?`);
// only ever moves a timestamp backward, so reruns are stable
const stmtBackdateUser = db.prepare(`UPDATE users SET created_at = ? WHERE id = ? AND created_at > ?`);

/**
 * Full wipe for the gallery's reset action, queued like seeding. Children
 * before parents (foreign_keys is ON). The requester's session dies with the
 * rest — the reset handler re-creates the Inspector and re-issues a cookie
 * in the same response.
 */
export function wipeDemoData(): Promise<void> {
  return enqueue(() => {
    db.exec(
      `DELETE FROM elo_history;
       DELETE FROM boards;
       DELETE FROM sessions;
       DELETE FROM tournaments;
       DELETE FROM users;`,
    );
  });
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function ensureBot(name: string): UserRow {
  const user = upsertGoogleUser(`demo:bot:${name.toLowerCase()}`, null, name, null);
  return user.handle ? user : claimHandleWithSuffix(user, name);
}

function ensureAmbientTournament(seed: string, createdAt: number): TournamentRow {
  const existing = stmtTournamentBySeed.get(seed) as TournamentRow | undefined;
  if (existing) return existing;
  const t = stmtInsertBackdated.get(seed, createdAt) as TournamentRow;
  // Same rename as placeUser — ambient tournaments are indistinguishable
  // from real ones on purpose (they SHOULD participate in placement).
  const name = `Tournament #${t.id}`;
  stmtRename.run(name, t.id);
  return { ...t, name };
}

/**
 * Play one board to completion as `userId` with a deterministic, slightly
 * erratic strategy: mostly passes with the occasional low bid (spreads bid
 * grades across the whole excellent→poor range) and rng-chosen legal cards
 * (spreads scores so matchpoint fields aren't all ties). Yields the event
 * loop after every action — the DDS solves inside each submit are
 * synchronous WASM, so this is what keeps /health and live requests
 * responsive while the seeder works.
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

async function seedTournament(
  spec: SeedProfile['tournaments'][number],
  bots: UserRow[],
  inspector: UserRow,
  now: number,
): Promise<TournamentRow> {
  const createdAt = now - spec.ageS;
  const t = ensureAmbientTournament(spec.seed, createdAt);
  const players = spec.players.map((i) => bots[i]);
  if (spec.inspector) players.push(inspector);
  const target = spec.boards ?? BOARDS_PER_TOURNAMENT;
  for (const [pi, player] of players.entries()) {
    if (target === 0) {
      // A started-but-live board: makes this tournament a grace-tier target
      // with a starter, and gives the lobby a "board in progress" to show.
      if (!stmtBoardExists.get(t.id, player.id, 1)) {
        const b = loadBoard(t, player.id, 1, true)!;
        await ensureAdvanced(b);
      }
      continue;
    }
    stmtDeleteUnfinished.run(t.id, player.id);
    const done = (stmtDoneCount.get(t.id, player.id) as { n: number }).n;
    for (let no = done + 1; no <= target; no++) {
      await playBoard(t, player.id, no, seededRng(`${player.google_id}:${spec.seed}:${no}`));
    }
    // Timestamp realism: finished boards look played shortly after the
    // tournament opened, staggered per player (drives monthlyEloDelta,
    // stats series ordering, and the lobby's "last played"). Runs even when
    // the boards already existed, so a seed interrupted between playing and
    // backdating heals on the next pass.
    stmtBackdateBoards.run(createdAt + 3600 + pi * 1800, t.id, player.id);
  }
  return t;
}

let queue: Promise<void> = Promise.resolve();

/** One queue for every seeder entry point: wipes and seeds never interleave. */
function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function seedDemo(log: FastifyBaseLogger, profile: SeedProfile = DEFAULT_PROFILE): Promise<void> {
  return enqueue(() => doSeed(log, profile));
}

async function doSeed(log: FastifyBaseLogger, profile: SeedProfile): Promise<void> {
  const started = Date.now();
  const now = Math.floor(started / 1000);
  const inspector = ensureDemoUser();
  const bots = profile.bots.map(ensureBot);
  // "Learning since" on stats pages must predate the backdated results
  for (const u of [inspector, ...bots]) stmtBackdateUser.run(now - USER_AGE_S, u.id, now - USER_AGE_S);

  for (const spec of profile.tournaments) {
    const t = await seedTournament(spec, bots, inspector, now);
    log.info(`demo seed: ${t.name} (${spec.seed}) ready`);
  }

  if (profile.exhibitFields) {
    // Result-view exhibits deserve a real matchpoint field: pre-play bots
    // through just the scenario's board. Exhibit tournaments never rate or
    // surface in placement/lobby/stats — enforced by kind = 'exhibit'
    // filters in tournaments.ts/stats.ts, not by convention.
    for (const s of SCENARIOS) {
      if (!s.fieldBots) continue;
      const t = ensureExhibitTournament(s.seed);
      for (const bot of bots.slice(0, s.fieldBots)) {
        stmtDeleteUnfinished.run(t.id, bot.id);
        if ((stmtDoneCount.get(t.id, bot.id) as { n: number }).n > 0) continue;
        await playBoard(t, bot.id, s.boardNo, seededRng(`${bot.google_id}:exhibit:${s.seed}:${s.boardNo}`));
      }
      log.info(`demo seed: exhibit field for '${s.id}' ready`);
    }
  }

  log.info(`demo seed: complete in ${Math.round((Date.now() - started) / 1000)}s`);
}
