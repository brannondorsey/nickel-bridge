import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'bridge-elo-')), 'test.db');

// dynamic imports so DB_PATH is set before the db module initializes
const { db } = await import('../src/db.js');
const { recomputeElo, standings } = await import('../src/tournaments.js');

function addUser(name: string): number {
  return (
    db.prepare(`INSERT INTO users (google_id, name) VALUES (?, ?) RETURNING id`).get(`dev:${name}`, name) as {
      id: number;
    }
  ).id;
}

function addTournament(name: string): number {
  return (db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, 'seed') RETURNING id`).get(name) as { id: number })
    .id;
}

function finishBoards(tournamentId: number, userId: number, scores: number[]): void {
  scores.forEach((score, i) => {
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns) VALUES (?, ?, ?, 'done', ?)`,
    ).run(tournamentId, userId, i + 1, score);
  });
}

const elo = (userId: number) => (db.prepare(`SELECT elo FROM users WHERE id = ?`).get(userId) as { elo: number }).elo;

describe('continuous Elo recompute', () => {
  let alice = 0;
  let bob = 0;
  let carol = 0;
  let t1 = 0;

  beforeAll(() => {
    alice = addUser('alice');
    bob = addUser('bob');
    carol = addUser('carol');
    t1 = addTournament('T1');
    finishBoards(t1, alice, [400, 400, 400, 400]);
    finishBoards(t1, bob, [100, 100, 100, 100]);
  });

  it('rates a completed head-to-head tournament', () => {
    recomputeElo();
    expect(elo(alice)).toBe(1212);
    expect(elo(bob)).toBe(1188);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history`).get()).toEqual({ n: 2 });
  });

  it('is idempotent', () => {
    recomputeElo();
    recomputeElo();
    expect(elo(alice)).toBe(1212);
    expect(elo(bob)).toBe(1188);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history`).get()).toEqual({ n: 2 });
  });

  it('re-ranks when a late finisher joins an old tournament', () => {
    finishBoards(t1, carol, [1000, 1000, 1000, 1000]); // carol beats both
    recomputeElo();
    expect(elo(carol)).toBeGreaterThan(elo(alice));
    expect(elo(alice)).toBeGreaterThan(elo(bob));
    // history rebuilt: one snapshot per participant
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history`).get()).toEqual({ n: 3 });
    // ratings are conserved up to rounding
    const total = elo(alice) + elo(bob) + elo(carol);
    expect(Math.abs(total - 3600)).toBeLessThanOrEqual(3);
  });

  it('ignores incomplete players and later tournaments feed off updated ratings', () => {
    const t2 = addTournament('T2');
    finishBoards(t2, alice, [500, 500, 500, 500]);
    finishBoards(t2, bob, [600, 600, 600, 600]); // bob wins t2
    finishBoards(t2, carol, [50, 50]); // incomplete — not rated
    recomputeElo();
    const s = standings(t2);
    expect(s.find((x) => x.userId === carol)?.complete).toBe(false);
    // bob (lower-rated after t1) beats alice → gains more than 12
    const bobDelta =
      (db.prepare(`SELECT after - before AS d FROM elo_history WHERE tournament_id = ? AND user_id = ?`).get(t2, bob) as {
        d: number;
      }).d;
    expect(bobDelta).toBeGreaterThan(12);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE tournament_id = ?`).get(t2)).toEqual({ n: 2 });
  });
});
