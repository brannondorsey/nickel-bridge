import type { FastifyBaseLogger } from 'fastify';
import { upsertGoogleUser } from './auth.js';
import { playThrough } from './bot-play.js';
import { BOARDS_PER_TOURNAMENT, TournamentRow, UserRow, db } from './db.js';
import { claimHandleWithSuffix, ensureDemoUser, ensureExhibitTournament, ensureNewCrosser } from './demo.js';
import { ensureAdvanced, loadBoard } from './game.js';
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
const stmtBoardExists = db.prepare(
  `SELECT 1 FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`,
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

export function ensureBot(name: string): UserRow {
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
    await playThrough(t, player.id, target, (no) => `${player.google_id}:${spec.seed}:${no}`);
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
  // The New Crosser is ensured here too (also called synchronously from
  // /api/demo/scenarios) purely for a plausible "Learning since" date — it
  // never plays a board, so its stats page stays the cold-start empty state.
  const newCrosser = ensureNewCrosser();
  // "Learning since" on stats pages must predate the backdated results
  for (const u of [inspector, newCrosser, ...bots]) stmtBackdateUser.run(now - USER_AGE_S, u.id, now - USER_AGE_S);

  for (const spec of profile.tournaments) {
    const t = await seedTournament(spec, bots, inspector, now);
    log.info(`demo seed: ${t.name} (${spec.seed}) ready`);
  }

  if (profile.exhibitFields) {
    // Result-view exhibits deserve a real matchpoint field: pre-play bots
    // through the scenario's board — or, for a whole-tournament reveal
    // (completesTournament), through every board, so the field has a
    // genuine rank-of-N to show. Exhibit tournaments never rate or surface
    // in placement/lobby/stats — enforced by kind = 'exhibit' filters in
    // tournaments.ts/stats.ts, not by convention.
    for (const s of SCENARIOS) {
      if (!s.fieldBots) continue;
      const t = ensureExhibitTournament(s.seed);
      const lastBoard = s.completesTournament ? BOARDS_PER_TOURNAMENT : s.boardNo;
      for (const bot of bots.slice(0, s.fieldBots)) {
        await playThrough(t, bot.id, lastBoard, (no) => `${bot.google_id}:exhibit:${s.seed}:${no}`);
      }
      log.info(`demo seed: exhibit field for '${s.id}' ready`);
    }
  }

  log.info(`demo seed: complete in ${Math.round((Date.now() - started) / 1000)}s`);
}
