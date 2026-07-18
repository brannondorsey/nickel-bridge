import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('difficulty');

/**
 * Robot-difficulty plumbing: schema defaults, the preference endpoint,
 * difficulty-matched placement, and — the invariant that matters — identical
 * sampled robots for every player on the same non-expert board.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await makeApp();
});

describe('difficulty defaults and preference endpoint', () => {
  it('a bare tournament insert defaults to legacy perfect; a fresh user to intermediate', async () => {
    const { db } = await import('../src/db.js');
    const t = db
      .prepare(`INSERT INTO tournaments (name, seed) VALUES ('legacy', 'legacy-seed') RETURNING *`)
      .get() as any;
    expect(t.difficulty).toBe('perfect');
    expect(t.board_difficulties).toBeNull();

    const alice = new TestClient(app, 'DefaultAlice');
    await alice.login();
    const me = await alice.get('/api/me');
    expect(me.user.difficulty).toBe('intermediate');
  });

  it('POST /api/me/difficulty updates the preference; bad and hidden values 400', async () => {
    const bob = new TestClient(app, 'PrefBob');
    await bob.login();
    const res = await bob.post('/api/me/difficulty', { difficulty: 'beginner' });
    expect(res.user.difficulty).toBe('beginner');
    expect((await bob.get('/api/me')).user.difficulty).toBe('beginner');

    const bad = await bob.raw('POST', '/api/me/difficulty', { difficulty: 'impossible' });
    expect(bad.statusCode).toBe(400);
    // 'perfect' is the internal legacy tier — never player-selectable
    const hidden = await bob.raw('POST', '/api/me/difficulty', { difficulty: 'perfect' });
    expect(hidden.statusCode).toBe(400);
  });
});

describe('difficulty-matched placement', () => {
  it('placement stamps new tournaments with the preference and never mixes tiers', async () => {
    const beg1 = new TestClient(app, 'BegOne');
    await beg1.login();
    await beg1.post('/api/me/difficulty', { difficulty: 'beginner' });
    const placed = await beg1.post('/api/play');
    const t1 = await beg1.get(`/api/tournaments/${placed.tournamentId}`);
    expect(t1.difficulty).toBe('beginner');

    // An expert-pref user placed next must not land in the young beginner
    // tournament, grace window notwithstanding.
    const exp1 = new TestClient(app, 'ExpOne');
    await exp1.login();
    await exp1.post('/api/me/difficulty', { difficulty: 'expert' });
    const expPlaced = await exp1.post('/api/play');
    expect(expPlaced.tournamentId).not.toBe(placed.tournamentId);
    const t2 = await exp1.get(`/api/tournaments/${expPlaced.tournamentId}`);
    expect(t2.difficulty).toBe('expert');

    // A second beginner IS grace-joined into the first beginner tournament.
    const beg2 = new TestClient(app, 'BegTwo');
    await beg2.login();
    await beg2.post('/api/me/difficulty', { difficulty: 'beginner' });
    const joined = await beg2.post('/api/play');
    expect(joined.tournamentId).toBe(placed.tournamentId);
  });

  it('boardView carries the per-board difficulty, and a uniform schedule is stamped at creation', async () => {
    const carol = new TestClient(app, 'ViewCarol');
    await carol.login();
    await carol.post('/api/me/difficulty', { difficulty: 'expert' });
    const placed = await carol.post('/api/play');
    const view = await carol.get(`/api/tournaments/${placed.tournamentId}/boards/1`);
    expect(view.difficulty).toBe('expert');
    const { db } = await import('../src/db.js');
    const row = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(placed.tournamentId) as any;
    expect(JSON.parse(row.board_difficulties)).toEqual(['expert', 'expert', 'expert', 'expert']);
  });

  it('difficulty is a per-board property: a mixed schedule resolves per board', async () => {
    const { db } = await import('../src/db.js');
    const t = db
      .prepare(
        `INSERT INTO tournaments (name, seed, difficulty, board_difficulties)
         VALUES ('mixed', 'mixed-seed', 'expert', ?) RETURNING *`,
      )
      .get(JSON.stringify(['beginner', 'intermediate', 'expert', 'perfect'])) as any;
    const dana = new TestClient(app, 'MixedDana');
    await dana.login();
    const views = [];
    for (let no = 1; no <= 4; no++) views.push(await dana.get(`/api/tournaments/${t.id}/boards/${no}`));
    expect(views.map((v) => v.difficulty)).toEqual(['beginner', 'intermediate', 'expert', 'perfect']);
    const detail = await dana.get(`/api/tournaments/${t.id}`);
    expect(detail.boardDifficulties).toEqual(['beginner', 'intermediate', 'expert', 'perfect']);
  });
});

describe('sampled robots are deterministic across players', () => {
  it('two users replay a beginner board to the identical auction, play, and score', async () => {
    const p1 = new TestClient(app, 'DetOne');
    const p2 = new TestClient(app, 'DetTwo');
    await p1.login();
    await p2.login();
    await p1.post('/api/me/difficulty', { difficulty: 'beginner' });
    await p2.post('/api/me/difficulty', { difficulty: 'beginner' });
    const placed1 = await p1.post('/api/play');
    const placed2 = await p2.post('/api/play');
    expect(placed2.tournamentId).toBe(placed1.tournamentId); // grace-joined

    const seen1 = await playBoard(p1, placed1.tournamentId, 1);
    const seen2 = await playBoard(p2, placed1.tournamentId, 1);
    const last1 = seen1[seen1.length - 1];
    const last2 = seen2[seen2.length - 1];
    expect(last1.auction).toEqual(last2.auction);
    expect(last1.playHistory).toEqual(last2.playHistory);
    expect(last1.contract).toEqual(last2.contract);
    expect(last1.declarerTricks).toEqual(last2.declarerTricks);
  }, 120_000);
});
