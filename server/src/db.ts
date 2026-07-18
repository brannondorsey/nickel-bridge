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
  board_no INTEGER NOT NULL,             -- 1..4
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
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_key ON users(handle_key) WHERE handle_key IS NOT NULL;`);

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
  created_at: number;
}

export const BOARDS_PER_TOURNAMENT = 4;

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
