import type { FastifyBaseLogger } from 'fastify';
import { BOARDS_PER_TOURNAMENT, TournamentRow, UserRow, db } from './db.js';
import { ensureDemoUser, ensureExhibitTournament } from './demo.js';
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
 * writes are timestamps — tournaments are backdated at creation and board
 * updated_at is aligned to the tournament's age — which shifts *when* things
 * appear to have happened, never *what* happened.
 *
 * Deterministic: bot strategies draw from an rng seeded per (bot,
 * tournament, board), so reseeding a wiped volume reproduces identical data.
 *
 * Runs fire-and-forget after listen (index.ts) so Fly's /health check is
 * never blocked by DDS solves; ~40 boards fill in over the first minute or
 * two. Idempotent two ways: a demo_meta marker short-circuits a fully seeded
 * database, and every step is check-before-create so a crashed or
 * reset-interrupted half-seed self-heals on the next run.
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

const SEED_VERSION = 'v1'; // bump whenever the seed design changes

const stmtUserByGoogle = db.prepare(`SELECT * FROM users WHERE google_id = ?`);
const stmtInsertBot = db.prepare(
  `INSERT INTO users (google_id, name, handle, handle_key) VALUES (?, ?, ?, ?) RETURNING *`,
);
const stmtHandleTaken = db.prepare(`SELECT 1 FROM users WHERE handle_key = ?`);
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
const stmtBackdateBoards = db.prepare(`UPDATE boards SET updated_at = ? WHERE tournament_id = ? AND user_id = ?`);

function ensureMeta(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/**
 * Full wipe for the gallery's reset action. Children before parents
 * (foreign_keys is ON). The requester's session dies with the rest — the
 * reset handler re-creates the Inspector and re-issues a cookie in the same
 * response.
 */
export function wipeAllData(): void {
  ensureMeta();
  db.exec(
    `DELETE FROM demo_meta;
     DELETE FROM elo_history;
     DELETE FROM boards;
     DELETE FROM sessions;
     DELETE FROM tournaments;
     DELETE FROM users;`,
  );
}

// Deterministic rng: fnv-1a string hash feeding mulberry32.
function rngFor(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function ensureBot(name: string): UserRow {
  const gid = `demo:bot:${name.toLowerCase()}`;
  const existing = stmtUserByGoogle.get(gid) as UserRow | undefined;
  if (existing) return existing;
  // A tester may have claimed the bot's handle first — suffix until free.
  let handle = name;
  for (let i = 2; stmtHandleTaken.get(handle.toLowerCase()); i++) handle = `${name} ${i}`;
  return stmtInsertBot.get(gid, name, handle, handle.toLowerCase()) as UserRow;
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
 * (spreads scores so matchpoint fields aren't all ties).
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
    const done = (stmtDoneCount.get(t.id, player.id) as { n: number }).n;
    if (done >= target) continue;
    for (let no = done + 1; no <= target; no++) {
      await playBoard(t, player.id, no, rngFor(`${player.google_id}:${spec.seed}:${no}`));
      await tick();
    }
    // Timestamp realism: finished boards look played shortly after the
    // tournament opened, staggered per player (drives monthlyEloDelta,
    // stats series ordering, and the lobby's "last played").
    stmtBackdateBoards.run(createdAt + 3600 + pi * 1800, t.id, player.id);
  }
  return t;
}

let queue: Promise<void> = Promise.resolve();

/**
 * Serialized entry point: a reset's reseed queues behind a still-running
 * boot seed instead of interleaving with it. If the wipe yanked the data out
 * from under an in-flight run, that run fails (logged) and the queued one
 * rebuilds from the empty database — every step re-checks existence.
 */
export function seedDemo(log: FastifyBaseLogger, profile: SeedProfile = DEFAULT_PROFILE): Promise<void> {
  const run = queue.then(() => doSeed(log, profile));
  queue = run.catch(() => {});
  return run;
}

async function doSeed(log: FastifyBaseLogger, profile: SeedProfile): Promise<void> {
  ensureMeta();
  const seeded = db.prepare(`SELECT value FROM demo_meta WHERE key = 'seeded'`).get() as
    | { value: string }
    | undefined;
  if (seeded?.value === SEED_VERSION) return;

  const started = Date.now();
  const now = Math.floor(started / 1000);
  const inspector = ensureDemoUser();
  const bots = profile.bots.map(ensureBot);

  for (const spec of profile.tournaments) {
    const t = await seedTournament(spec, bots, inspector, now);
    log.info(`demo seed: ${t.name} (${spec.seed}) ready`);
  }

  if (profile.exhibitFields) {
    // Result-view exhibits deserve a real matchpoint field: pre-play bots
    // through just the scenario's board. Nobody ever completes all four
    // boards of an exhibit, so exhibits never enter the Elo replay.
    for (const s of SCENARIOS) {
      if (!s.fieldBots) continue;
      const t = ensureExhibitTournament(s.seed);
      for (const bot of bots.slice(0, s.fieldBots)) {
        if ((stmtDoneCount.get(t.id, bot.id) as { n: number }).n > 0) continue;
        await playBoard(t, bot.id, s.boardNo, rngFor(`${bot.google_id}:exhibit:${s.seed}:${s.boardNo}`));
        await tick();
      }
      log.info(`demo seed: exhibit field for '${s.id}' ready`);
    }
  }

  db.prepare(
    `INSERT INTO demo_meta (key, value) VALUES ('seeded', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SEED_VERSION);
  log.info(`demo seed: complete in ${Math.round((Date.now() - started) / 1000)}s`);
}
