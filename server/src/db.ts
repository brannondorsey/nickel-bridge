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
  elo: number;
  created_at: number;
}

/** Tournaments never close: they stay joinable forever to maximize the field. */
export interface TournamentRow {
  id: number;
  name: string;
  seed: string;
  /** 'standard' = real play; 'exhibit' = demo-mode scenario holder, excluded from placement/rating/lobby/stats */
  kind: 'standard' | 'exhibit';
  /** placement-tier label ('perfect' = legacy true-DD); per-board truth via boardDifficulty() */
  difficulty: Difficulty;
  /** JSON Difficulty[4], one entry per board; NULL = uniform at `difficulty` */
  board_difficulties: string | null;
  /** 1 = the benchmark AI personas play this tournament (stamped at creation, never backfilled) */
  ai_field: number;
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
  updated_at: number;
}
