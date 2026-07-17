import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('data-epoch');

const { db, DATA_EPOCH, applyDataEpoch } = await import('../src/db.js');

/** User tables present in a database (excludes SQLite internals). */
function tables(handle: Database.Database): string[] {
  return (
    handle
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((t) => t.name);
}

describe('DATA_EPOCH one-shot reset', () => {
  it('stamps a fresh database with the current epoch and keeps the schema', () => {
    // The module db was created from nothing by this suite's freshDbEnv:
    // boot must have stamped it without a wipe, and the schema exists.
    expect(db.pragma('user_version', { simple: true })).toBe(DATA_EPOCH);
    expect(tables(db)).toContain('users');
    expect(tables(db)).toContain('boards');
  });

  it('wipes a pre-epoch database exactly once, then becomes a no-op', () => {
    const stale = new Database(':memory:'); // user_version 0, like any pre-epoch file
    stale.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`);
    stale.exec(`CREATE TABLE boards (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))`);
    stale.prepare(`INSERT INTO users (name) VALUES ('old-world player')`).run();
    stale.prepare(`INSERT INTO boards (user_id) VALUES (1)`).run();

    expect(applyDataEpoch(stale, 7)).toBe(true); // wiped
    expect(tables(stale)).toEqual([]);
    expect(stale.pragma('user_version', { simple: true })).toBe(7);
    expect(stale.pragma('foreign_keys', { simple: true })).toBe(1); // enforcement restored

    expect(applyDataEpoch(stale, 7)).toBe(false); // already stamped: no-op
  });

  it('never wipes a database stamped at or beyond the target epoch', () => {
    const current = new Database(':memory:');
    current.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY)`);
    current.prepare(`INSERT INTO users DEFAULT VALUES`).run();
    current.pragma('user_version = 9');

    expect(applyDataEpoch(current, 9)).toBe(false);
    expect(applyDataEpoch(current, 3)).toBe(false); // never "downgrades"
    expect(current.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
    expect(current.pragma('user_version', { simple: true })).toBe(9);
  });
});
