import { describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, playBoard, TestClient } from './helpers.js';

/**
 * The TOPS tile (stats.ts's totals.tops): boards where a player took full
 * matchpoints against everyone who has played that deal.
 *
 * Driven by direct board inserts rather than real play, because the two things
 * worth pinning are boundary cases the default test strategy can't produce —
 * both players playing identically tie every board at 50%, which would let
 * every assertion here pass vacuously. Scores are inserted per board with
 * explicit updated_at so "most recent top" is testable independently of board
 * order. Own db file so no other suite's boards land in the field.
 */
freshDbEnv('tops');

const { db } = await import('../src/db.js');

/** a standard tournament with no boards yet */
const mkTournament = (name: string) =>
  (
    db
      .prepare(`INSERT INTO tournaments (name, seed, difficulty) VALUES (?, ?, 'intermediate') RETURNING id`)
      .get(name, `${name}-seed`) as { id: number }
  ).id;

const mkUser = (handle: string) =>
  (
    db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES (?, ?, ?, ?) RETURNING id`)
      .get(`dev:${handle}`, handle, handle, handle.toLowerCase()) as { id: number }
  ).id;

const insert = db.prepare(
  `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, bid_evals, updated_at)
   VALUES (?, ?, ?, 'done', ?, '[]', ?)`,
);

describe('tops (boards taken outright)', () => {
  it('counts full-matchpoint boards only, and names the most recently finished one', async () => {
    const app = await makeApp();
    const viewer = new TestClient(app, 'TopsViewer');
    await viewer.login();

    const tid = mkTournament('Tops');
    const topper = mkUser('Topper');
    const rival = mkUser('TopsRival');
    const t = { id: tid };

    // 1: outright win -> a top, finished last of the four (updated_at 5000)
    insert.run(t.id, topper, 1, 400, 5000);
    insert.run(t.id, rival, 1, 100, 5000);
    // 2: identical scores -> matchpoints splits the tie at 50%, NOT a top
    insert.run(t.id, topper, 2, 200, 2000);
    insert.run(t.id, rival, 2, 200, 2000);
    // 3: outright win -> a top, but finished BEFORE board 1
    insert.run(t.id, topper, 3, 300, 3000);
    insert.run(t.id, rival, 3, 100, 3000);
    // 4: nobody else has played it -> a lone finisher scores 50%, not a free top
    insert.run(t.id, topper, 4, 300, 4000);

    const stats = await viewer.get(`/api/users/${topper}/stats`);
    expect(stats.totals.boardsCompleted).toBe(4);
    expect(stats.totals.tops.count).toBe(2);
    // board 1, not board 3: `latest` goes by completion time, not board order
    expect(stats.totals.tops.latest).toEqual({ tournamentId: t.id, boardNo: 1 });

    // the losing side of the same boards earns none of them
    const rivalStats = await viewer.get(`/api/users/${rival}/stats`);
    expect(rivalStats.totals.tops).toEqual({ count: 0, latest: null });
  });

  it('breaks a same-second tie toward the later board', async () => {
    const app = await makeApp();
    const viewer = new TestClient(app, 'TieViewer');
    await viewer.login();

    const tid = mkTournament('Ties');
    const tier = mkUser('Tier');
    const foil = mkUser('TieFoil');

    // updated_at is second-resolution (db.ts), so two boards finishing inside
    // one second is ordinary — a persona sweeping a tournament, or a claim
    // fast-forward. Both of these are tops, both stamped 7000.
    insert.run(tid, tier, 1, 400, 7000);
    insert.run(tid, foil, 1, 100, 7000);
    insert.run(tid, tier, 2, 400, 7000);
    insert.run(tid, foil, 2, 100, 7000);

    const stats = await viewer.get(`/api/users/${tier}/stats`);
    expect(stats.totals.tops.count).toBe(2);
    // board 2, not board 1: boards are normally played in ascending order, so
    // the later one is the better guess at "most recent" — and pinning the
    // direction keeps the tile's deep link from flipping under a refactor
    expect(stats.totals.tops.latest).toEqual({ tournamentId: tid, boardNo: 2 });
  });

  it('keeps per-board pcts off the client-facing standings rows', async () => {
    const app = await makeApp();
    const viewer = new TestClient(app, 'TopsShape');
    await viewer.login();
    const placed = await viewer.post('/api/play');
    await playBoard(viewer, placed.tournamentId, 1); // a scored board, so the field isn't empty

    // standings() carries boardPcts for stats.ts's tally; visibleStandings()
    // strips it, so the tournament payload stays the shape web/src/api.ts
    // mirrors — see StandingDetail in tournaments.ts.
    const view = await viewer.get(`/api/tournaments/${placed.tournamentId}`);
    expect(view.standings.length).toBeGreaterThan(0);
    for (const s of view.standings) expect(s).not.toHaveProperty('boardPcts');
  });
});
