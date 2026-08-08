import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Difficulty, SettableDifficulty } from '@bridge/ai';

const DB_PATH = process.env.DB_PATH ?? './data/bridge.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT NOT NULL,
  picture TEXT,
  elo INTEGER NOT NULL DEFAULT 1200,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  seed TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- 1..4. The CHECK is on the storage CLASS, not the range, and both halves of
  -- that are deliberate. INTEGER here is an affinity rather than a type: this
  -- table is not STRICT, so SQLite stores 2.5 verbatim as a REAL — a value
  -- distinct from every other under UNIQUE below, i.e. an unbounded supply of
  -- extra "boards" per (tournament, user). typeof() is what actually refuses
  -- that. The 1..4 range stays at the route (app.ts's boardNoParam), because
  -- it is a rule about the game rather than about the row, and test suites
  -- legitimately fabricate rows past the fourth board to stand in for days of
  -- play. Note this only reaches databases created from this DDL: SQLite
  -- cannot add a constraint to an existing table without rebuilding it, and a
  -- rebuild of the production boards table is not worth it for a hole the
  -- boundary check already closes.
  board_no INTEGER NOT NULL CHECK (typeof(board_no) = 'integer'),
  state TEXT NOT NULL DEFAULT 'bidding', -- bidding | playing | done
  calls TEXT NOT NULL DEFAULT '[]',      -- JSON number[]
  plays TEXT NOT NULL DEFAULT '[]',      -- JSON number[]
  bid_evals TEXT NOT NULL DEFAULT '[]',  -- JSON: evaluation per human call
  contract TEXT,                          -- JSON Contract | null once auction ends
  tricks_declarer INTEGER,
  score_ns INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (tournament_id, user_id, board_no)
);

CREATE TABLE IF NOT EXISTS elo_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  before INTEGER NOT NULL,
  after INTEGER NOT NULL
);

-- Analyze's per-board verdict cache (server/src/analyze.ts). Computed on the
-- FIRST open of a board's analysis — never on completion — and served cached
-- thereafter: the pipeline is seeded and DDS is deterministic, so a recompute
-- is byte-identical (the cache and the screen are the same claim made twice).
-- "core" holds stages 1-3 (DD trace, per-ply verdicts, moments); "par" holds
-- stage 4 (DD table, par, counterfactual auctions) and stays NULL until a
-- lens that needs it is opened, so a play-lens read never pays for
-- CalcDDTablePBN. A version mismatch (ANALYZE_VERSION) forces a recompute —
-- a cached analysis computed against different robots is a stale accusation.
-- ON DELETE CASCADE is load-bearing: boards are deleted by demo mode's
-- per-exhibit wipe-unfinished-then-replay (demo.ts) and full reset
-- (demo-seed.ts), and with foreign_keys ON a cache row without the cascade
-- turns either into FOREIGN KEY constraint failed — a cache must never be
-- able to block its parent's delete.
CREATE TABLE IF NOT EXISTS board_analyses (
  board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  core TEXT NOT NULL,
  par TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_boards_tournament ON boards(tournament_id, board_no);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
-- Every other board sweep in the codebase is scoped to one user or one
-- tournament, so idx_boards_user (user-first) serves them. The activity feed
-- (activity.ts) is the one query that starts from a time window and spans all
-- users, and it would otherwise scan the whole table on every load.
CREATE INDEX IF NOT EXISTS idx_boards_updated ON boards(updated_at);
`);

// Migration: `handle`/`handle_key` were added after the initial schema, so existing
// databases need an explicit ALTER TABLE (CREATE TABLE IF NOT EXISTS above is a no-op
// on them). `handle` is the user-chosen display name shown everywhere in the app;
// `handle_key` is its lowercased form, used only to enforce case-insensitive uniqueness
// via a partial index (NULL until a user completes the first-login handle prompt).
const userColumns = new Set((db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name));
if (!userColumns.has('handle')) db.exec(`ALTER TABLE users ADD COLUMN handle TEXT`);
if (!userColumns.has('handle_key')) db.exec(`ALTER TABLE users ADD COLUMN handle_key TEXT`);
// Migration: robot difficulty preference — the tier a user wants placement to
// match them into (see tournaments.difficulty below). Backend-only for now:
// settable via POST /api/me/difficulty, no web UI yet. Default is the middle
// tier — nobody faces the legacy perfect-knowledge robots unknowingly.
if (!userColumns.has('difficulty')) {
  db.exec(`ALTER TABLE users ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'intermediate'`);
}
// Migration: `kind` discriminates the three benchmark AI personas ('ai',
// created only by ensureAiPlayers in ai-players.ts) from real accounts.
// A first-class column, not a google_id prefix convention, for the same
// reason as tournaments.kind below: standings, Elo, placement, leaderboard,
// and stats all must partition on it, and hanging that on an id string
// would break the moment the id scheme changes.
if (!userColumns.has('kind')) {
  db.exec(`ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_key ON users(handle_key) WHERE handle_key IS NOT NULL;`);
// Migration: `onboarded_at` — when the user finished (or skipped) the
// first-crossing tour (web/src/onboarding). NULL = the web app shows the tour
// after the handle prompt. Existing accounts are grandfathered as already
// onboarded at migration time: the tour teaches the app to newcomers, and
// springing it on every veteran the day it ships would read as a nag, not a
// welcome.
if (!userColumns.has('onboarded_at')) {
  db.exec(`ALTER TABLE users ADD COLUMN onboarded_at INTEGER`);
  db.exec(`UPDATE users SET onboarded_at = unixepoch()`);
}
// Migration: `ladder_listed` — may a visitor without an account see this
// player on /leaderboard? The ladder is the ONLY thing about a human that
// reads signed out (profiles refuse an anonymous caller, the activity feed is
// gated), so this one flag is the whole of "can I be seen by someone who
// hasn't signed in". Defaults to 1, which is exactly the behaviour every
// existing account already had — this adds a way out, it doesn't change what
// happens to anyone who ignores it. Signed-in players always see the full
// ladder: the setting is about strangers, not about hiding from the field you
// are being scored against.
if (!userColumns.has('ladder_listed')) {
  db.exec(`ALTER TABLE users ADD COLUMN ladder_listed INTEGER NOT NULL DEFAULT 1`);
}
// Migration: `fast_forward` — replay a claim's settled tricks compressed
// (1, the shipped behaviour) or at ordinary play pacing (0). Account state
// rather than a localStorage flag like the theme: it says how this PERSON
// wants to be shown a hand they no longer have decisions in, which doesn't
// change because they picked up a different device. Night mode is the
// exception, and only because it has to be applied before first paint by an
// inline script (see "Night mode" in CONTRIBUTING.md) — no server round trip
// can answer that in time.
if (!userColumns.has('fast_forward')) {
  db.exec(`ALTER TABLE users ADD COLUMN fast_forward INTEGER NOT NULL DEFAULT 1`);
}
// Migration: `bid_feedback` — show the post-call grading toast (1, the
// shipped behaviour) or suppress it (0). The toast is deliberately excellent
// for a learner and unwanted noise for a stronger player who is here to
// compete rather than study. Account state, not localStorage, for the same
// reason as fast_forward: it describes how this PERSON wants to be coached,
// not a property of the device. Purely a rendering gate — grading is still
// computed and stored in bidEvals on every submitCall regardless of this
// flag, so bid-accuracy stats and the post-board "YOUR BIDDING" review table
// are unaffected either way.
if (!userColumns.has('bid_feedback')) {
  db.exec(`ALTER TABLE users ADD COLUMN bid_feedback INTEGER NOT NULL DEFAULT 1`);
}
// Migration: `double_tap_bid` — submit a bid on a second tap of the already-
// selected call, without pressing the confirm CTA (0, the shipped default;
// 1 opts back in). Unlike its three siblings above, this migration does NOT
// preserve prior behaviour on purpose: player reports of accidentally
// submitting a bid are exactly what turning this off by default fixes. The
// confirm CTA ("BID X →") is unaffected either way — it has always been an
// equal, independent path to the same submitCall, see BidBox.tsx — so this
// only removes the shortcut, never the ability to bid. Account state, not
// localStorage, for the same reason as fast_forward/bid_feedback: it
// describes how this PERSON wants to interact with the bid box, not a
// property of the device.
if (!userColumns.has('double_tap_bid')) {
  db.exec(`ALTER TABLE users ADD COLUMN double_tap_bid INTEGER NOT NULL DEFAULT 0`);
}
// Migration: `trick_clear_mode` — how a completed trick leaves the table:
// 'auto' (the shipped behaviour — the trick holds for GLIDE_MS + HOLD_MS,
// then sweeps to the winner on its own) or 'tap' (holds indefinitely until
// the player taps the trick area, then sweeps immediately). TEXT rather than
// the INTEGER boolean every sibling above uses: this is shipping with two
// values, but it names a MODE ("how"), not a yes/no toggle, so a third
// pacing choice later (a slower auto, say) extends the column instead of
// needing a second one — the same reasoning `difficulty`/`tournaments.kind`
// already use for their own TEXT enums. Defaults to 'auto', preserving prior
// behaviour for every existing account, same as fast_forward/bid_feedback/
// ladder_listed (double_tap_bid is the one sibling that deliberately does
// NOT do this). Account state, not localStorage, for the same reason as
// those three: it says how this PERSON wants a trick they can no longer
// affect to leave the table, not a property of the device. Purely a CLIENT
// pacing choice — server-side scoring, robot play and claim resolution never
// read this column.
if (!userColumns.has('trick_clear_mode')) {
  db.exec(`ALTER TABLE users ADD COLUMN trick_clear_mode TEXT NOT NULL DEFAULT 'auto'`);
}

// Migration: `beta_features` — opt in to features still being tried out
// before a general release (currently: Analyze, the post-board review
// screen). Unlike every other pref above, its default is environment-
// dependent rather than a fixed literal: DEFAULT is evaluated once, right
// here, against THIS process's env, which both backfills existing rows
// correctly for wherever this migration happens to run AND becomes SQLite's
// column default for every future INSERT that doesn't name the column (the
// same mechanism ladder_listed/fast_forward/bid_feedback lean on) — so a
// fresh signup needs no second code path to inherit it. Off (0) in
// production, where nobody has asked for early access yet; on (1) wherever
// DEV_AUTH or DEMO is set — PR previews and the permanent demo app share
// that exact shape (see deploy-preview/deploy-demo in ci.yml) — so testers
// and click-testers see new work without hunting for a switch. A production
// account reaches beta features only by deliberately flipping "Beta
// features" in Settings (POST /api/me/prefs), which is how a feature like
// Analyze reaches a handful of named testers ahead of everyone else.
if (!userColumns.has('beta_features')) {
  const betaDefault = process.env.DEV_AUTH === '1' || process.env.DEMO === '1' ? 1 : 0;
  db.exec(`ALTER TABLE users ADD COLUMN beta_features INTEGER NOT NULL DEFAULT ${betaDefault}`);
}

// Migration: `kind` discriminates demo-mode exhibit tournaments ('exhibit',
// created only by demo.ts under DEMO=1) from real ones ('standard'). It is a
// first-class column — not a name convention — because placement, the Elo
// replay, the lobby list, and stats all must exclude exhibits, and hanging
// that on a display string would break the moment tournament naming changes.
const tournamentColumns = new Set(
  (db.prepare(`PRAGMA table_info(tournaments)`).all() as { name: string }[]).map((c) => c.name),
);
if (!tournamentColumns.has('kind')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'`);
}
// Migration: robot card-play difficulty. `difficulty` is the tournament's
// placement-tier label, stamped at creation from the creating user's
// preference and immutable thereafter; `board_difficulties` is the per-board
// truth (JSON Difficulty[4], NULL = uniform at `difficulty`) — difficulty is
// a PER-BOARD property resolved via boardDifficulty() in tournaments.ts,
// identical for every player on a board (invariant 1), never per-user. The
// ADD COLUMN defaults backfill all existing tournaments as 'perfect' with a
// NULL schedule, i.e. exactly the historical true-DD robots on every board.
if (!tournamentColumns.has('difficulty')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'perfect'`);
}
if (!tournamentColumns.has('board_difficulties')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN board_difficulties TEXT`);
}
// Migration: `ai_field` marks tournaments whose Field includes the three
// benchmark AI personas (ai-players.ts). Stamped 1 only where tournaments
// are created for real play (placeUser's creation path and demo-seed's
// ambient tournaments) — never backfilled, so legacy tournaments, exhibit
// holders, and raw-inserted fixture/test tournaments keep 0 and can never
// acquire AI board rows.
if (!tournamentColumns.has('ai_field')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN ai_field INTEGER NOT NULL DEFAULT 0`);
}

// Migration: `origin_tournament_id`/`origin_board_no`/`branch_ply` identify a
// 'rehearsal'-kind tournament's origin — the real, finished board it branched
// from, and the plays[] index (see analyze.ts's ply convention) of the first
// redecided card. NULL for every non-rehearsal row. Kept directly on
// tournaments rather than a side table: a rehearsal is 1:1 with exactly one
// tournament row and one branch point, the same reasoning that already put
// kind/ai_field/board_difficulties here instead of elsewhere.
if (!tournamentColumns.has('origin_tournament_id')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN origin_tournament_id INTEGER REFERENCES tournaments(id)`);
}
if (!tournamentColumns.has('origin_board_no')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN origin_board_no INTEGER`);
}
if (!tournamentColumns.has('branch_ply')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN branch_ply INTEGER`);
}

// Migration: `claimed_at_ply` — the plays[] index of the first card the
// server played as part of resolving a laydown claim (advanceRobots'
// claim gate in game.ts), NULL when the board finished without claiming.
// GameBoard.claimed has always been transient (per-request, never saved), so
// before this column a finished board could not say whether — or where — its
// tail was claim-played. Analyze needs that boundary at rest: cards past it
// were played BY THE SERVER for both sides (true-DD, see invariant 1's claim
// note), so grading them against the human is a false statement. Backfilled
// NULL: pre-migration boards re-derive the boundary by replaying the claim
// gate's solve walk (server/src/analyze.ts), and cache the answer.
const boardColumns = new Set(
  (db.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[]).map((c) => c.name),
);
if (!boardColumns.has('claimed_at_ply')) {
  db.exec(`ALTER TABLE boards ADD COLUMN claimed_at_ply INTEGER`);
}

// Migration: board_analyses briefly existed without ON DELETE CASCADE (see
// the DDL comment above — a cache row blocked board deletes). SQLite can't
// alter a foreign key in place, and the table is a pure recomputable cache,
// so a non-cascading copy is simply dropped and recreated empty.
const baFks = db.prepare(`PRAGMA foreign_key_list(board_analyses)`).all() as { on_delete: string }[];
if (baFks.length > 0 && baFks[0].on_delete !== 'CASCADE') {
  db.exec(`DROP TABLE board_analyses;
CREATE TABLE board_analyses (
  board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  core TEXT NOT NULL,
  par TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);`);
}

export interface UserRow {
  id: number;
  google_id: string;
  email: string | null;
  name: string;
  picture: string | null;
  handle: string | null;
  handle_key: string | null;
  /** robot difficulty preference — drives placement (see tournaments.difficulty); never 'perfect' */
  difficulty: SettableDifficulty;
  /** 'human' = real account; 'ai' = benchmark persona (ai-players.ts), excluded from Elo/placement/leaderboard/stats and shown as a shadow row in standings */
  kind: 'human' | 'ai';
  /** unix seconds when the first-crossing tour was completed or skipped; NULL = show it */
  onboarded_at: number | null;
  /** 1 = a signed-out visitor may see this player on /leaderboard; 0 = the ladder omits them for anonymous callers only */
  ladder_listed: number;
  /** 1 = replay a claim's settled tricks compressed; 0 = at ordinary play pacing */
  fast_forward: number;
  /** 1 = show the post-call grading toast; 0 = suppress it (grading is still computed and stored either way) */
  bid_feedback: number;
  /** 1 = this account can reach features still in beta (e.g. Analyze); env-dependent default, see the migration comment in db.ts */
  beta_features: number;
  /** 1 = a second tap on the selected call submits it; 0 (default) = only the confirm CTA submits */
  double_tap_bid: number;
  /** how a completed trick leaves the table: 'auto' (default, times out on its own) or 'tap' (holds until the player taps the trick area) */
  trick_clear_mode: 'auto' | 'tap';
  elo: number;
  created_at: number;
}

/** Tournaments never close: they stay joinable forever to maximize the field. */
export interface TournamentRow {
  id: number;
  name: string;
  seed: string;
  /** 'standard' = real play; 'exhibit' = demo-mode scenario holder; 'rehearsal' = a Play-From-Here branch — all three non-'standard' kinds are excluded from placement/rating/lobby/stats via the same kind='standard' allowlist everywhere */
  kind: 'standard' | 'exhibit' | 'rehearsal';
  /** placement-tier label ('perfect' = legacy true-DD); per-board truth via boardDifficulty() */
  difficulty: Difficulty;
  /** JSON Difficulty[4], one entry per board; NULL = uniform at `difficulty` */
  board_difficulties: string | null;
  /** 1 = the benchmark AI personas play this tournament (stamped at creation, never backfilled) */
  ai_field: number;
  /** rehearsal only: the real tournament/board this branched from, and the plays[] index of the first redecided card. NULL on every other kind. */
  origin_tournament_id: number | null;
  origin_board_no: number | null;
  branch_ply: number | null;
  created_at: number;
}

export const BOARDS_PER_TOURNAMENT = 4;

/**
 * Display order for the benchmark AI personas when scores tie: strongest
 * first (The Shark above The Regular above The Novice). Keyed on google_id —
 * the personas' stable identity (ai-players.ts); handles are display copy
 * and can be renamed. Humans (or unknown ids) rank 0, ahead of every
 * persona, preserving the "a human outranks a persona they tie with" rule.
 */
export function aiTieRank(googleId: string | null | undefined): number {
  switch (googleId) {
    case 'ai:expert':
      return 1;
    case 'ai:intermediate':
      return 2;
    case 'ai:beginner':
      return 3;
    default:
      return 0;
  }
}

export interface BoardRow {
  id: number;
  tournament_id: number;
  user_id: number;
  board_no: number;
  state: 'bidding' | 'playing' | 'done';
  calls: string;
  plays: string;
  bid_evals: string;
  contract: string | null;
  tricks_declarer: number | null;
  score_ns: number | null;
  /** plays[] index of the first server-played card of a resolved claim; NULL = no claim (or pre-migration board — re-derived by analyze.ts) */
  claimed_at_ply: number | null;
  updated_at: number;
}
