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

  // Both are on their first crossing, so both are provisional and each side's
  // K carries core's OPPONENT_DAMP (0.5): 24 * 0.5 * (1 - 0.5) = 6, not the
  // classic 12. See PROVISIONAL in packages/core/src/elo.ts.
  it('rates a completed head-to-head tournament', () => {
    recomputeElo();
    expect(elo(alice)).toBe(1206);
    expect(elo(bob)).toBe(1194);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history`).get()).toEqual({ n: 2 });
  });

  it('is idempotent', () => {
    recomputeElo();
    recomputeElo();
    expect(elo(alice)).toBe(1206);
    expect(elo(bob)).toBe(1194);
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
    // t2 is rated off the ratings t1 LEFT BEHIND, not off ELO_INITIAL: bob
    // enters below alice (she beat him in t1) and his win is an upset.
    // Asserting the size of the upset premium is no longer useful — both are
    // still inside the provisional window, so K is damped to 12 (see
    // PROVISIONAL in packages/core/src/elo.ts) and at these near-equal
    // ratings the premium rounds away entirely. So assert the carry-forward
    // itself, which is what this test is named for.
    const row = db
      .prepare(`SELECT before, after FROM elo_history WHERE tournament_id = ? AND user_id = ?`)
      .get(t2, bob) as { before: number; after: number };
    const aliceBefore = (
      db.prepare(`SELECT before FROM elo_history WHERE tournament_id = ? AND user_id = ?`).get(t2, alice) as {
        before: number;
      }
    ).before;
    expect(row.before).toBeLessThan(aliceBefore); // carried forward from t1
    expect(row.after - row.before).toBeGreaterThanOrEqual(6); // and he gained
    expect(db.prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE tournament_id = ?`).get(t2)).toEqual({ n: 2 });
  });
});
