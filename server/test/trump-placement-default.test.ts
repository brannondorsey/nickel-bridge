import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Trumps-on-the-left becomes the default placement — db.ts's re-default
 * migration for databases that already carry the column at its old 'suit'
 * default.
 *
 * The migration runs at db.ts import time, so the fixture below has to be
 * written BEFORE the dynamic import — which also means this must stay its own
 * test file (vitest isolates the module registry per file, and db.ts is a
 * singleton a sibling suite would already have initialized). Same shape as
 * crossing-number.test.ts, for the same reasons.
 *
 * What is actually under test is the pair of properties that make a
 * data-discarding migration safe to ship: it moves EVERY existing row onto
 * the new default (including one that explicitly held the old one — the
 * column cannot tell a choice from a default, and the trade is taken
 * deliberately), and the structure it leaves behind is what its own guard
 * reads, so a second boot skips it and a player's 'suit' is never re-flipped.
 */
const dir = mkdtempSync(join(tmpdir(), 'bridge-trumpdefault-'));
const DB_PATH = join(dir, 'test.db');

// Pre-migration shape: the base users table plus the column exactly as #180's
// migration wrote it. Everything else db.ts wants is added by its own
// migrations, which is the point — the assertions below run against the real
// statements rather than a copy pasted into this file.
const seed = new Database(DB_PATH);
seed.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT,
    name TEXT NOT NULL,
    picture TEXT,
    elo INTEGER NOT NULL DEFAULT 1200,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  ALTER TABLE users ADD COLUMN trump_placement TEXT NOT NULL DEFAULT 'suit';
`);
const insLegacy = seed.prepare(`INSERT INTO users (google_id, name, trump_placement) VALUES (?, ?, ?)`);
insLegacy.run('dev:never-looked', 'Never Looked', 'suit'); // the default, never touched
insLegacy.run('dev:chose-suit', 'Chose Suit', 'suit'); // an explicit choice, indistinguishable
insLegacy.run('dev:chose-left', 'Chose Left', 'left'); // already opted in
seed.close();

// Importing db.ts is what runs the migration under test.
process.env.DB_PATH = DB_PATH;
const { db } = await import('../src/db.js');

const placementOf = (googleId: string) =>
  (db.prepare(`SELECT trump_placement FROM users WHERE google_id = ?`).get(googleId) as {
    trump_placement: string;
  }).trump_placement;
const usersTableSql = () =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get() as { sql: string }).sql;

describe('the trumps-left re-default', () => {
  it('moves every existing account onto the new default', () => {
    expect(placementOf('dev:never-looked')).toBe('left');
    expect(placementOf('dev:chose-left')).toBe('left');
    // ...including one that had explicitly asked for ♠♥♦♣. The column records
    // only the value, never whether anyone chose it, so this is the accepted
    // cost of re-defaulting rather than an oversight — see the migration's
    // comment in db.ts.
    expect(placementOf('dev:chose-suit')).toBe('left');
  });

  it('keeps the rest of the row', () => {
    const row = db.prepare(`SELECT name, elo FROM users WHERE google_id = 'dev:chose-suit'`).get() as {
      name: string;
      elo: number;
    };
    expect(row).toEqual({ name: 'Chose Suit', elo: 1200 });
  });

  it('makes it the default for accounts created afterwards', () => {
    db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:new', 'New')`).run();
    expect(placementOf('dev:new')).toBe('left');
  });

  it('leaves the structure its own guard keys on, so a second boot skips it', () => {
    // Deliberately not a re-entry check: db.ts runs once per process, so
    // nothing here can actually re-run the migration. What CAN be asserted is
    // the post-state the guard reads on the next boot — the default recorded
    // in the schema itself, which is this migration's answer to the structural
    // guard every column-adding migration in that file gets for free.
    expect(usersTableSql()).toMatch(/trump_placement TEXT NOT NULL DEFAULT 'left'/);
  });

  it('still lets an account hold suit order', () => {
    db.prepare(`UPDATE users SET trump_placement = 'suit' WHERE google_id = 'dev:new'`).run();
    expect(placementOf('dev:new')).toBe('suit');
  });
});
