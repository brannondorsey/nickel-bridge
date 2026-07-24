import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, playBoard, TestClient } from './helpers.js';

freshDbEnv('redesign');

/**
 * API additions for the UI redesign: leaderboard movement arrows, monthly
 * rating delta, and tournament metadata (createdAt, myLastPlayedAt,
 * myEloDelta, myBoards). All are derived read-only from existing tables.
 */
let app: Awaited<ReturnType<typeof makeApp>>;
let alice: TestClient;
let bob: TestClient;

async function completeTournament(clients: TestClient[]): Promise<number> {
  let tid = 0;
  for (const c of clients) {
    const { tournamentId } = await c.post('/api/play');
    tid = tournamentId;
    for (let no = 1; no <= 4; no++) await playBoard(c, tournamentId, no);
  }
  return tid;
}

beforeAll(async () => {
  app = await makeApp();
  alice = new TestClient(app, 'Alice');
  bob = new TestClient(app, 'Bob');
  await alice.login();
  await bob.login();
});

// Movement math is exercised via leaderboardMovement() directly rather than
// GET /api/leaderboard: that route now omits players below the provisional
// quota (PROVISIONAL_MIN_TOURNAMENTS), but alice/bob/carol here only ever
// complete 1-2 tournaments — well under it — so they'd never appear in the
// route's list even though the movement math itself is unaffected by that
// display-eligibility filter.
describe('leaderboard movement', () => {
  it('is null for everyone before any rated tournament exists', async () => {
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const aliceId = (await alice.get('/api/me')).user.id;
    const bobId = (await bob.get('/api/me')).user.id;
    const movement = leaderboardMovement();
    expect(movement.has(aliceId)).toBe(false);
    expect(movement.has(bobId)).toBe(false);
  });

  it('is null after the first rated tournament (no previous snapshot) and numeric after the second', async () => {
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const aliceId = (await alice.get('/api/me')).user.id;
    const bobId = (await bob.get('/api/me')).user.id;

    await completeTournament([alice, bob]);
    let movement = leaderboardMovement();
    expect(movement.has(aliceId)).toBe(false);
    expect(movement.has(bobId)).toBe(false);

    await completeTournament([alice, bob]);
    movement = leaderboardMovement();
    expect(typeof movement.get(aliceId)).toBe('number');
    expect(typeof movement.get(bobId)).toBe('number');
    // movement is prevRank − currentRank, so the field's movements sum to 0
    const sum = [...movement.values()].reduce((a, v) => a + v, 0);
    expect(sum).toBe(0);
  });

  it('gives a late joiner of an old tournament numeric movement (retroactive re-rank)', async () => {
    // JIT placement grace-serves Carol the oldest young under-filled
    // tournament, which is older than the latest rated one — the recompute
    // inserts her into history retroactively, so she exists in both snapshots.
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const carol = new TestClient(app, 'Carol');
    await carol.login();
    const carolId = (await carol.get('/api/me')).user.id;
    const { tournamentId } = await carol.post('/api/play');
    for (let no = 1; no <= 4; no++) await playBoard(carol, tournamentId, no);
    const movement = leaderboardMovement();
    expect(typeof movement.get(carolId)).toBe('number');
  });

  it('is null for a player whose first rated tournament is the latest one', async () => {
    // Placement makes this rare end-to-end, so exercise the function directly:
    // Grace debuts at the newest rated tournament → no previous snapshot.
    const grace = new TestClient(app, 'Grace');
    await grace.login();
    const graceId = (await grace.get('/api/me')).user.id as number;
    const { db } = await import('../src/db.js');
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const { maxTid } = db.prepare(`SELECT MAX(tournament_id) AS maxTid FROM elo_history`).get() as {
      maxTid: number;
    };
    db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, 1200, 1210)`).run(
      graceId,
      maxTid,
    );
    try {
      const movement = leaderboardMovement();
      expect(movement.has(graceId)).toBe(false); // the route maps a missing entry to null
      expect([...movement.values()].some((v) => typeof v === 'number')).toBe(true);
    } finally {
      db.prepare(`DELETE FROM elo_history WHERE user_id = ?`).run(graceId);
    }
  });
});

describe('monthly rating delta', () => {
  it('is null for an unrated player', async () => {
    const dan = new TestClient(app, 'Dan');
    await dan.login();
    const me = await dan.get('/api/me');
    const stats = await dan.get(`/api/users/${me.user.id}/stats`);
    expect(stats.totals.monthlyEloDelta).toBeNull();
  });

  it('equals currentElo − 1200 when all rated play happened this month', async () => {
    const me = await alice.get('/api/me');
    const stats = await alice.get(`/api/users/${me.user.id}/stats`);
    expect(stats.totals.monthlyEloDelta).toBe(stats.totals.currentElo - 1200);
  });
});

describe('tournament metadata', () => {
  it('list rows carry createdAt and myLastPlayedAt', async () => {
    const { tournaments } = await alice.get('/api/tournaments');
    expect(tournaments.length).toBeGreaterThan(0);
    for (const t of tournaments) {
      expect(typeof t.createdAt).toBe('number');
      // Alice finished every tournament she appears in
      expect(typeof t.myLastPlayedAt).toBe('number');
    }
  });

  it('myLastPlayedAt is null for a joined-but-unplayed tournament', async () => {
    const erin = new TestClient(app, 'Erin');
    await erin.login();
    const { tournamentId } = await erin.post('/api/play');
    // starting board 1 (a GET deals it) joins without finishing anything
    await erin.get(`/api/tournaments/${tournamentId}/boards/1`);
    const { tournaments } = await erin.get('/api/tournaments');
    const mine = tournaments.find((t: { id: number }) => t.id === tournamentId);
    expect(mine.myLastPlayedAt).toBeNull();
  });

  it('detail carries createdAt, myEloDelta and myBoards consistent with board results', async () => {
    const { tournaments } = await alice.get('/api/tournaments');
    const finished = tournaments.find((t: { myDone: number }) => t.myDone === 4);
    const detail = await alice.get(`/api/tournaments/${finished.id}`);

    expect(typeof detail.createdAt).toBe('number');
    expect(detail.myDone).toBe(4);

    // rated tournament with 2+ complete players → delta present and coherent
    expect(detail.myEloDelta).not.toBeNull();
    expect(typeof detail.myEloDelta.before).toBe('number');
    expect(typeof detail.myEloDelta.after).toBe('number');

    expect(detail.myBoards.length).toBe(4);
    const board1 = await alice.get(`/api/tournaments/${finished.id}/boards/1`);
    const mine = detail.myBoards.find((b: { no: number }) => b.no === 1);
    expect(mine.state).toBe('done');
    expect(mine.contractLabel).toBe(board1.result.contractLabel);
    expect(mine.scoreNS).toBe(board1.result.scoreNS);
    expect(mine.pct).toBe(board1.result.pct);
  });

  it('myBoards reports non-done boards without result fields and omits unstarted boards', async () => {
    const frank = new TestClient(app, 'Frank');
    await frank.login();
    const { tournamentId } = await frank.post('/api/play');
    await frank.get(`/api/tournaments/${tournamentId}/boards/1`); // deal board 1, leave it in bidding
    const detail = await frank.get(`/api/tournaments/${tournamentId}`);
    const started = detail.myBoards.find((b: { no: number }) => b.no === 1);
    expect(started.state).toBe('bidding');
    expect(started.contractLabel).toBeNull();
    expect(started.pct).toBeNull();
    expect(detail.myBoards.every((b: { no: number }) => b.no === 1)).toBe(true);
    // unrated player in an unfinished tournament → no elo delta
    expect(detail.myEloDelta).toBeNull();
  });
});
