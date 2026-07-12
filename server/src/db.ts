import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  after INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_boards_tournament ON boards(tournament_id, board_no);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

export interface UserRow {
  id: number;
  google_id: string;
  email: string | null;
  name: string;
  picture: string | null;
  elo: number;
  created_at: number;
}

/** Tournaments never close: they stay joinable forever to maximize the field. */
export interface TournamentRow {
  id: number;
  name: string;
  seed: string;
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
