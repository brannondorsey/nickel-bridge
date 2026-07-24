import { PASS, boardConditions, makeBid } from '@bridge/core';
import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('stats');
const app = await makeApp();
const { db } = await import('../src/db.js');

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
    expect(stats.totals.bestPct).toBeNull();
    expect(stats.totals.worstPct).toBeNull();
    expect(stats.totals.avgBidAccuracy).toBeNull();
    expect(stats.eloSeries).toEqual([]);
    expect(stats.pctSeries).toEqual([]);
    expect(stats.accuracySeries).toEqual([]);
    expect(stats.bidTypes).toEqual([]);
    expect(stats.conventions).toEqual([]);
    expect(stats.trickDelta.boards).toBe(0);
    expect(stats.trickDelta.avgDelta).toBeNull();
    expect(stats.trickDelta.buckets).toEqual([-3, -2, -1, 0, 1, 2, 3].map((delta) => ({ delta, count: 0 })));
    expect(stats.percentiles.elo).toBeNull();
    expect(stats.percentiles.avgPct).toBeNull();
    expect(stats.percentiles.declaring).toBeNull();
    expect(stats.totals.currentElo).toBe(1200);
    expect(stats.contractMix).toEqual({
      partscore: { boards: 0, made: 0 },
      game: { boards: 0, made: 0 },
      slam: { boards: 0, made: 0 },
      doubled: { boards: 0, made: 0 },
      strains: { notrump: 0, major: 0, minor: 0 },
    });
    expect(stats.dailyBoards).toEqual([]);
    expect(stats.rivals).toEqual([]);
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

    // elo matches the stored rating — alice's 1 rated tournament is below the
    // leaderboard's provisional quota, so she isn't in its list yet (covered
    // in api.test.ts); check the underlying rating directly instead
    const mineElo = (db.prepare(`SELECT elo FROM users WHERE id = ?`).get(aliceId) as { elo: number }).elo;
    expect(stats.eloSeries).toHaveLength(1);
    expect(stats.eloSeries[0].elo).toBe(mineElo);
    expect(stats.totals.currentElo).toBe(mineElo);
    expect(stats.totals.peakElo).toBeGreaterThanOrEqual(Math.max(1200, mineElo));

    // pct matches the tournament standings
    const t = await alice.get(`/api/tournaments/${tid}`);
    const standing = t.standings.find((s: any) => s.userId === aliceId);
    expect(stats.pctSeries).toHaveLength(1);
    expect(stats.pctSeries[0].pct).toBe(standing.totalPct);
    expect(stats.pctSeries[0].boards).toBe(4);
    expect(stats.pctSeries[0].fieldSize).toBe(2);
    expect(stats.pctSeries[0].finishedAt).toBeGreaterThan(0);

    // with a single pctSeries entry, best and worst crossing are that entry
    expect(stats.totals.bestPct).toEqual({
      pct: stats.pctSeries[0].pct,
      tournamentName: stats.pctSeries[0].tournamentName,
      tournamentId: stats.pctSeries[0].tournamentId,
    });
    expect(stats.totals.worstPct).toEqual(stats.totals.bestPct);

    // every graded call is counted exactly once
    const grades = stats.totals.gradeCounts;
    const graded = grades.excellent + grades.good + grades.fair + grades.poor;
    expect(graded).toBe(stats.accuracySeries[0].calls);
    expect(graded).toBeGreaterThan(0);
    expect(stats.accuracySeries[0].accuracy).toBe(stats.totals.avgBidAccuracy);

    // bid types partition the graded calls, ranked best to worst
    const KNOWN_CATEGORIES = ['opening', 'response', 'rebid', 'overcall', 'double', 'pass'];
    expect(stats.bidTypes.length).toBeGreaterThan(0);
    expect(stats.bidTypes.reduce((s: number, b: any) => s + b.total, 0)).toBe(graded);
    expect(stats.bidTypes.reduce((s: number, b: any) => s + b.satisfactory, 0)).toBe(grades.excellent + grades.good);
    const rates = stats.bidTypes.map((b: any) => b.satisfactory / b.total);
    expect([...rates].sort((a: number, b: number) => b - a)).toEqual(rates);
    for (const b of stats.bidTypes) {
      expect(KNOWN_CATEGORIES).toContain(b.category);
      expect(b.satisfactory).toBeLessThanOrEqual(b.total);
    }

    // conventions are a subset of the graded calls, along a different axis
    const KNOWN_FAMILIES = ['stayman', 'jacobyTransfer', 'blackwood', 'gerber', 'weakTwo', 'negativeDouble', 'michaels'];
    const conventionTotal = stats.conventions.reduce((s: number, c: any) => s + c.total, 0);
    expect(conventionTotal).toBeLessThanOrEqual(graded);
    for (const c of stats.conventions) {
      expect(KNOWN_FAMILIES).toContain(c.family);
      expect(c.satisfactory).toBeLessThanOrEqual(c.total);
    }

    // every board lands in exactly one bucket
    const { declarer, defense, passedOut } = stats.totals;
    expect(declarer.boards + defense.boards + passedOut).toBe(4);
    expect(declarer.made).toBeLessThanOrEqual(declarer.boards);
    expect(defense.beat).toBeLessThanOrEqual(defense.boards);

    // signed trick-delta histogram partitions declaring boards
    const buckets = stats.trickDelta.buckets;
    expect(buckets.map((b: any) => b.delta)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(buckets.reduce((s: number, b: any) => s + b.count, 0)).toBe(declarer.boards);
    expect(stats.trickDelta.boards).toBe(declarer.boards);
    // non-negative buckets are exactly the made contracts, negative buckets exactly the downs
    const madeFromBuckets = buckets.filter((b: any) => b.delta >= 0).reduce((s: number, b: any) => s + b.count, 0);
    expect(madeFromBuckets).toBe(declarer.made);

    // contract mix: tiers and strains both partition the declaring boards
    const cm = stats.contractMix;
    expect(cm.partscore.boards + cm.game.boards + cm.slam.boards).toBe(declarer.boards);
    for (const bucket of [cm.partscore, cm.game, cm.slam, cm.doubled]) {
      expect(bucket.made).toBeLessThanOrEqual(bucket.boards);
    }
    expect(cm.doubled.boards).toBeLessThanOrEqual(declarer.boards);
    expect(cm.strains.notrump + cm.strains.major + cm.strains.minor).toBe(declarer.boards);

    // daily-boards calendar: sparse, ascending, and sums to every completed board
    expect(stats.dailyBoards.length).toBeGreaterThan(0);
    for (const d of stats.dailyBoards) expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dates = stats.dailyBoards.map((d: any) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(stats.dailyBoards.reduce((s: number, d: any) => s + d.count, 0)).toBe(stats.totals.boardsCompleted);
  });

  it('buckets completed boards by UTC calendar day, ascending', async () => {
    const uid = await userId(carol);
    const tid = (db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', 'seed') RETURNING id`).get() as { id: number })
      .id;
    // Four pass-out boards (empty auction, no contract) split across two UTC
    // days — content doesn't matter for this feature, only `updated_at` does.
    // Raw INSERT with an explicit updated_at, same pattern the Stayman test
    // above uses (precedent for backdating via raw SQL against test-owned
    // rows: ai-players.test.ts's `UPDATE boards SET ...`).
    const day1 = Math.floor(new Date('2026-01-05T18:00:00Z').getTime() / 1000);
    const day2 = Math.floor(new Date('2026-01-07T03:00:00Z').getTime() / 1000);
    const insert = db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, calls, bid_evals, updated_at) VALUES (?, ?, ?, 'done', '[]', '[]', ?)`,
    );
    insert.run(tid, uid, 1, day1);
    insert.run(tid, uid, 2, day1);
    insert.run(tid, uid, 3, day2);

    const stats = await carol.get(`/api/users/${uid}/stats`);
    expect(stats.dailyBoards).toEqual([
      { date: '2026-01-05', count: 2 },
      { date: '2026-01-07', count: 1 },
    ]);
    expect(stats.dailyBoards.reduce((s: number, d: any) => s + d.count, 0)).toBe(stats.totals.boardsCompleted);
  });

  it('buckets a Stayman ask under conventions and excludes the natural continuation', async () => {
    const uid = await userId(carol);
    const tid = (db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', 'seed') RETURNING id`).get() as { id: number })
      .id;
    // board 1's dealer is North (seat 0), so calls[2] is South's (human) first call.
    // N:1NT P S:2C(Stayman) P N:2H P S:4H(natural raise) P P P
    expect(boardConditions(1).dealer).toBe(0);
    const calls = [
      makeBid(1, 4),
      PASS,
      makeBid(2, 0),
      PASS,
      makeBid(2, 2),
      PASS,
      makeBid(4, 2),
      PASS,
      PASS,
      PASS,
    ];
    const bidEvals = [
      { grade: 'excellent', score: 1 }, // South's Stayman ask
      { grade: 'good', score: 0.8 }, // South's natural raise — NOT a tracked convention
    ];
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, calls, bid_evals, updated_at) VALUES (?, ?, 1, 'done', ?, ?, unixepoch())`,
    ).run(tid, uid, JSON.stringify(calls), JSON.stringify(bidEvals));

    const stats = await carol.get(`/api/users/${uid}/stats`);
    expect(stats.conventions).toEqual([{ family: 'stayman', total: 1, satisfactory: 1 }]);
    expect(stats.bidTypes).toEqual([{ category: 'response', total: 2, satisfactory: 2 }]);
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

    // best/worst crossing, derived from pctSeries with the same tie-break (earlier wins ties)
    const [p0, p1] = stats.pctSeries;
    const expectedBest = p1.pct > p0.pct ? p1 : p0;
    const expectedWorst = p1.pct < p0.pct ? p1 : p0;
    expect(stats.totals.bestPct).toEqual({
      pct: expectedBest.pct,
      tournamentName: expectedBest.tournamentName,
      tournamentId: expectedBest.tournamentId,
    });
    expect(stats.totals.worstPct).toEqual({
      pct: expectedWorst.pct,
      tournamentName: expectedWorst.tournamentName,
      tournamentId: expectedWorst.tournamentId,
    });

    // percentiles: Alice and Bob are both rated/active; exactly one of them
    // beats the other on elo (or they tie at 0)
    expect(stats.percentiles.ratedPlayers).toBe(2);
    expect(stats.percentiles.activePlayers).toBeGreaterThanOrEqual(2);
    expect(stats.percentiles.elo).not.toBeNull();
    expect(stats.percentiles.elo).toBeGreaterThanOrEqual(0);
    expect(stats.percentiles.elo).toBeLessThanOrEqual(100);
    const bobStats = await bob.get(`/api/users/${await userId(bob)}/stats`);
    expect([stats.percentiles.elo, bobStats.percentiles.elo].sort()).not.toEqual([100, 100]);

    // declaring percentile is only populated once the player has a declaring
    // board; the pool size counts every player who has declared at least once
    if (stats.totals.declarer.boards > 0) {
      expect(stats.percentiles.declaring).not.toBeNull();
      expect(stats.percentiles.declaring).toBeGreaterThanOrEqual(0);
      expect(stats.percentiles.declaring).toBeLessThanOrEqual(100);
    } else {
      expect(stats.percentiles.declaring).toBeNull();
    }
    expect(stats.percentiles.declaringPlayers).toBeGreaterThanOrEqual(0);
  });

  it('tracks head-to-head rivalries, matching standings() and mirroring on the opponent\'s own profile', async () => {
    // Give alice a real, differentiated auction (the default strategy is
    // all-pass for both sides, which usually ties) so at least one shared
    // tournament has a genuine ahead/behind result, not just ties.
    const placed = await alice.post('/api/play');
    const tid = placed.tournamentId;
    for (let no = 1; no <= 4; no++) {
      await playBoard(alice, tid, no, { call: (view: any) => view.legalCalls.find((a: number) => a >= 3) ?? 0 });
    }
    await bob.post('/api/play');
    for (let no = 1; no <= 4; no++) await playBoard(bob, tid, no);

    const aliceId = await userId(alice);
    const bobId = await userId(bob);
    const aliceStats = await alice.get(`/api/users/${aliceId}/stats`);
    const bobStats = await bob.get(`/api/users/${bobId}/stats`);

    // Recompute the expected record straight from standings() — the same
    // source rivalries() itself reads — over every tournament both pctSeries
    // agree on, rather than re-asserting whatever the implementation
    // produced. Alice and bob may already share tournaments from earlier
    // tests in this file, so this doesn't assume a specific shared count.
    const sharedTids: number[] = aliceStats.pctSeries
      .map((p: any) => p.tournamentId)
      .filter((t: number) => bobStats.pctSeries.some((p: any) => p.tournamentId === t));
    expect(sharedTids.length).toBeGreaterThan(0);
    let ahead = 0;
    let behind = 0;
    let tied = 0;
    for (const t of sharedTids) {
      const standings = (await alice.get(`/api/tournaments/${t}`)).standings;
      const a = standings.find((s: any) => s.userId === aliceId).totalPct;
      const b = standings.find((s: any) => s.userId === bobId).totalPct;
      if (a > b) ahead++;
      else if (a < b) behind++;
      else tied++;
    }

    const rival = aliceStats.rivals.find((r: any) => r.userId === bobId);
    expect(rival).toBeDefined();
    expect(rival.handle).toBe('StatsBob');
    expect(rival.kind).toBe('human');
    expect(rival.shared).toBe(sharedTids.length);
    expect(rival.record).toEqual({ ahead, behind, tied });

    // mirror-image on bob's own profile: shared unchanged, ahead/behind swap
    const mirror = bobStats.rivals.find((r: any) => r.userId === aliceId);
    expect(mirror).toBeDefined();
    expect(mirror.shared).toBe(rival.shared);
    expect(mirror.record).toEqual({ ahead: behind, behind: ahead, tied });
  });

  it('ranks rivals by shared-tournament count, not by who is winning', async () => {
    // Fully synthetic boards (raw INSERT, same pattern as the day-bucket
    // test above) rather than real play: rivalries() only ever needs
    // score_ns (fed to standings()' matchpointing) — no auction/play state —
    // so this is the more direct way to pin down an exact ahead/behind
    // outcome per tournament instead of hoping real play lands one.
    const subject = new TestClient(app, 'RivalSubject');
    const oppA = new TestClient(app, 'RivalOppA'); // crosses paths twice, always tied
    const oppB = new TestClient(app, 'RivalOppB'); // crosses paths once, but wins every board
    await subject.login();
    await oppA.login();
    await oppB.login();
    const subjectId = await userId(subject);
    const oppAId = await userId(oppA);
    const oppBId = await userId(oppB);

    const mkTournament = (name: string) =>
      (db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, 'seed') RETURNING id`).get(name) as { id: number })
        .id;
    const insertBoard = db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, updated_at) VALUES (?, ?, ?, 'done', ?, unixepoch())`,
    );
    const playAllBoards = (tid: number, userId: number, scoreNS: number) => {
      for (let no = 1; no <= 4; no++) insertBoard.run(tid, userId, no, scoreNS);
    };

    // subject vs oppA, twice, tied every board (equal score_ns)
    const tidA1 = mkTournament('rival-a1');
    playAllBoards(tidA1, subjectId, 100);
    playAllBoards(tidA1, oppAId, 100);
    const tidA2 = mkTournament('rival-a2');
    playAllBoards(tidA2, subjectId, 100);
    playAllBoards(tidA2, oppAId, 100);

    // subject vs oppB, once, oppB wins every board outright
    const tidB1 = mkTournament('rival-b1');
    playAllBoards(tidB1, subjectId, 0);
    playAllBoards(tidB1, oppBId, 400);

    const stats = await subject.get(`/api/users/${subjectId}/stats`);
    expect(stats.rivals).toEqual([
      { userId: oppAId, handle: 'RivalOppA', kind: 'human', shared: 2, record: { ahead: 0, behind: 0, tied: 2 } },
      { userId: oppBId, handle: 'RivalOppB', kind: 'human', shared: 1, record: { ahead: 0, behind: 1, tied: 0 } },
    ]);
  });
});
