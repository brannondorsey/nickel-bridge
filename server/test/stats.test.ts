import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('stats');
const app = await makeApp();

const alice = new TestClient(app, 'StatsAlice');
const bob = new TestClient(app, 'StatsBob');
const carol = new TestClient(app, 'StatsCarol');
await alice.login();
await bob.login();
await carol.login();

async function userId(client: TestClient): Promise<number> {
  return (await client.get('/api/me')).user.id;
}

/** Both players complete the same fresh tournament so it rates. */
async function completeTournament(players: TestClient[]): Promise<number> {
  let tid = 0;
  for (const p of players) {
    const placed = await p.post('/api/play');
    tid = placed.tournamentId;
    for (let no = 1; no <= 4; no++) await playBoard(p, tid, no);
  }
  return tid;
}

describe('player stats', () => {
  it('requires auth and 404s on unknown or garbage ids', async () => {
    const anon = new TestClient(app, 'Anon');
    expect((await anon.raw('GET', '/api/users/1/stats')).statusCode).toBe(401);
    expect((await alice.raw('GET', '/api/users/999999/stats')).statusCode).toBe(404);
    expect((await alice.raw('GET', '/api/users/abc/stats')).statusCode).toBe(404);
  });

  it('404s on a signed-in user who never claimed a handle, instead of leaking a blank-name profile', async () => {
    const ghost = new TestClient(app, 'StatsGhost');
    await ghost.post('/auth/dev', { name: ghost.name }); // signed in, never claims a handle
    const ghostId = (await ghost.get('/api/me')).user.id;

    expect((await alice.raw('GET', `/api/users/${ghostId}/stats`)).statusCode).toBe(404);
  });

  it('returns an empty-but-valid payload for a user with no boards', async () => {
    const stats = await carol.get(`/api/users/${await userId(carol)}/stats`);
    expect(stats.totals.boardsCompleted).toBe(0);
    expect(stats.totals.tournamentsPlayed).toBe(0);
    expect(stats.totals.avgPct).toBeNull();
    expect(stats.totals.avgBidAccuracy).toBeNull();
    expect(stats.eloSeries).toEqual([]);
    expect(stats.pctSeries).toEqual([]);
    expect(stats.accuracySeries).toEqual([]);
    expect(stats.percentiles.elo).toBeNull();
    expect(stats.percentiles.avgPct).toBeNull();
    expect(stats.totals.currentElo).toBe(1200);
  });

  it('excludes in-progress boards from all stats', async () => {
    const placed = await carol.post('/api/play');
    const view = await carol.get(`/api/tournaments/${placed.tournamentId}/boards/${placed.boardNo}`);
    expect(view.state).not.toBe('done');
    const stats = await carol.get(`/api/users/${await userId(carol)}/stats`);
    expect(stats.totals.boardsCompleted).toBe(0);
    expect(stats.totals.tournamentsPlayed).toBe(0);
  });

  it('computes series and totals consistent with the rest of the API', async () => {
    const tid = await completeTournament([alice, bob]);
    const aliceId = await userId(alice);
    const stats = await alice.get(`/api/users/${aliceId}/stats`);

    expect(stats.user.handle).toBe('StatsAlice');
    expect(stats.totals.boardsCompleted).toBe(4);
    expect(stats.totals.tournamentsPlayed).toBe(1);
    expect(stats.totals.tournamentsCompleted).toBe(1);
    expect(stats.totals.ratedTournaments).toBe(1);

    // elo matches the leaderboard
    const lb = await alice.get('/api/leaderboard');
    const mine = lb.leaderboard.find((r: any) => r.id === aliceId);
    expect(stats.eloSeries).toHaveLength(1);
    expect(stats.eloSeries[0].elo).toBe(mine.elo);
    expect(stats.totals.currentElo).toBe(mine.elo);
    expect(stats.totals.peakElo).toBeGreaterThanOrEqual(Math.max(1200, mine.elo));

    // pct matches the tournament standings
    const t = await alice.get(`/api/tournaments/${tid}`);
    const standing = t.standings.find((s: any) => s.userId === aliceId);
    expect(stats.pctSeries).toHaveLength(1);
    expect(stats.pctSeries[0].pct).toBe(standing.totalPct);
    expect(stats.pctSeries[0].boards).toBe(4);
    expect(stats.pctSeries[0].fieldSize).toBe(2);
    expect(stats.pctSeries[0].finishedAt).toBeGreaterThan(0);

    // every graded call is counted exactly once
    const grades = stats.totals.gradeCounts;
    const graded = grades.excellent + grades.good + grades.fair + grades.poor;
    expect(graded).toBe(stats.accuracySeries[0].calls);
    expect(graded).toBeGreaterThan(0);
    expect(stats.accuracySeries[0].accuracy).toBe(stats.totals.avgBidAccuracy);

    // every board lands in exactly one bucket
    const { declarer, defense, passedOut } = stats.totals;
    expect(declarer.boards + defense.boards + passedOut).toBe(4);
    expect(declarer.made).toBeLessThanOrEqual(declarer.boards);
    expect(defense.beat).toBeLessThanOrEqual(defense.boards);
  });

  it('is visible to other signed-in players', async () => {
    const aliceId = await userId(alice);
    const viaBob = await bob.get(`/api/users/${aliceId}/stats`);
    const viaAlice = await alice.get(`/api/users/${aliceId}/stats`);
    expect(viaBob).toEqual(viaAlice);
  });

  it('orders series and compares against the field after more play', async () => {
    await completeTournament([alice, bob]);
    const aliceId = await userId(alice);
    const stats = await alice.get(`/api/users/${aliceId}/stats`);

    expect(stats.totals.boardsCompleted).toBe(8);
    expect(stats.eloSeries).toHaveLength(2);
    expect(stats.eloSeries[0].tournamentId).toBeLessThan(stats.eloSeries[1].tournamentId);
    expect(stats.pctSeries[0].finishedAt).toBeLessThanOrEqual(stats.pctSeries[1].finishedAt);
    expect(stats.totals.peakElo).toBe(Math.max(1200, ...stats.eloSeries.map((e: any) => e.elo)));

    // percentiles: Alice and Bob are both rated/active; exactly one of them
    // beats the other on elo (or they tie at 0)
    expect(stats.percentiles.ratedPlayers).toBe(2);
    expect(stats.percentiles.activePlayers).toBeGreaterThanOrEqual(2);
    expect(stats.percentiles.elo).not.toBeNull();
    expect(stats.percentiles.elo).toBeGreaterThanOrEqual(0);
    expect(stats.percentiles.elo).toBeLessThanOrEqual(100);
    const bobStats = await bob.get(`/api/users/${await userId(bob)}/stats`);
    expect([stats.percentiles.elo, bobStats.percentiles.elo].sort()).not.toEqual([100, 100]);
  });
});
