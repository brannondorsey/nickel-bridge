import { Contract, Deal, PASS, Seat, boardConditions, cardRank, cardSuit, dealBoard, makeBid, makeCard } from '@bridge/core';
import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('stats');
const app = await makeApp();
const { db } = await import('../src/db.js');
const { accumulateHoldUps, accumulateRuffs, classifyOpeningLead } = await import('../src/stats.js');

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
    expect(stats.ruffs).toEqual({
      declarerDummy: { plain: 0, over: 0, under: 0 },
      defense: { plain: 0, over: 0, under: 0 },
    });
    expect(stats.holdUps).toEqual({ opportunities: 0, taken: 0 });
    expect(stats.openingLeads).toEqual({
      boards: 0,
      suits: [0, 1, 2, 3].map((suit) => ({ suit, count: 0 })),
      style: { topOfSequence: 0, fourthBest: 0, other: 0 },
    });
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

    // with a single pctSeries entry, best and worst crossing are that entry
    expect(stats.totals.bestPct).toEqual({ pct: stats.pctSeries[0].pct, tournamentName: stats.pctSeries[0].tournamentName });
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

    // ruffs/hold-ups: pure structural sanity (real playthroughs are seed-dependent)
    const ruffTotal = (c: { plain: number; over: number; under: number }) => c.plain + c.over + c.under;
    expect(ruffTotal(stats.ruffs.declarerDummy)).toBeGreaterThanOrEqual(0);
    expect(ruffTotal(stats.ruffs.defense)).toBeGreaterThanOrEqual(0);
    expect(stats.holdUps.taken).toBeLessThanOrEqual(stats.holdUps.opportunities);

    // opening leads: pure structural sanity (real playthroughs are seed-dependent)
    expect(stats.openingLeads.suits.map((r: any) => r.suit)).toEqual([0, 1, 2, 3]);
    const leadSuitTotal = stats.openingLeads.suits.reduce((s: number, r: any) => s + r.count, 0);
    const leadStyleTotal =
      stats.openingLeads.style.topOfSequence + stats.openingLeads.style.fourthBest + stats.openingLeads.style.other;
    expect(leadSuitTotal).toBe(stats.openingLeads.boards);
    expect(leadStyleTotal).toBe(stats.openingLeads.boards);
    expect(stats.openingLeads.boards).toBeLessThanOrEqual(stats.totals.boardsCompleted);
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

  it('records the human opening lead only on East-declared boards, classified by suit and style', async () => {
    const uid = await userId(carol);
    // A fixed seed so the deal (and thus South's real holding) is
    // reproducible; playState only replays trick winners from the given
    // cards, it never validates follow-suit legality, so a hand-built
    // `plays` array is enough — no need to drive a real auction/play-out.
    const seed = 'opening-lead-fixture-seed';
    const boardNo = 1;
    const deal = dealBoard(seed, boardNo);
    const southHand = deal.hands[2]; // HUMAN_SEAT

    // Lead South's highest card in whichever suit South holds the most of,
    // so classifyOpeningLead's own logic (exercised directly in the
    // describe block below) determines the expected style here too — this
    // test is checking the loop wiring, not re-deriving the classification.
    const bySuit: number[][] = [[], [], [], []];
    for (const c of southHand) bySuit[cardSuit(c)].push(c);
    let ledSuit = 0;
    for (let s = 1; s < 4; s++) if (bySuit[s].length > bySuit[ledSuit].length) ledSuit = s;
    const suitCards = bySuit[ledSuit];
    const ledCard = suitCards.reduce((best, c) => (cardRank(c) > cardRank(best) ? c : best));
    const holdingRanks = suitCards.map(cardRank);
    const expectedStyle = classifyOpeningLead(cardRank(ledCard), holdingRanks);

    // Full 52-card play so the board reconstructs cleanly; only plays[0]
    // (the opening lead) matters for this feature.
    const allCards = ([0, 1, 2, 3] as const).flatMap((s) => deal.hands[s]);
    const plays = [ledCard, ...allCards.filter((c) => c !== ledCard)];

    const contract: Contract = { level: 1, strain: 4, declarer: 1, doubled: false, redoubled: false }; // East, NT
    const tid1 = (db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING id`).get(seed) as { id: number }).id;
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, calls, plays, bid_evals, contract, tricks_declarer, updated_at)
       VALUES (?, ?, ?, 'done', '[]', ?, '[]', ?, 7, unixepoch())`,
    ).run(tid1, uid, boardNo, JSON.stringify(plays), JSON.stringify(contract));

    // A second board, in a different tournament, with West declaring — the
    // human defends but North (not South) leads, so it must NOT count.
    const tid2 = (
      db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t2', ?) RETURNING id`).get(seed) as { id: number }
    ).id;
    const westContract: Contract = { level: 1, strain: 4, declarer: 3, doubled: false, redoubled: false };
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, calls, plays, bid_evals, contract, tricks_declarer, updated_at)
       VALUES (?, ?, ?, 'done', '[]', ?, '[]', ?, 7, unixepoch())`,
    ).run(tid2, uid, boardNo, JSON.stringify(plays), JSON.stringify(westContract));

    const stats = await carol.get(`/api/users/${uid}/stats`);
    expect(stats.openingLeads.boards).toBe(1);
    expect(stats.openingLeads.suits).toEqual(
      [0, 1, 2, 3].map((suit) => ({ suit, count: suit === ledSuit ? 1 : 0 })),
    );
    expect(stats.openingLeads.style).toEqual({
      topOfSequence: expectedStyle === 'topOfSequence' ? 1 : 0,
      fourthBest: expectedStyle === 'fourthBest' ? 1 : 0,
      other: expectedStyle === 'other' ? 1 : 0,
    });
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
    expect(stats.totals.bestPct).toEqual({ pct: expectedBest.pct, tournamentName: expectedBest.tournamentName });
    expect(stats.totals.worstPct).toEqual({ pct: expectedWorst.pct, tournamentName: expectedWorst.tournamentName });

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
});

// accumulateRuffs/accumulateHoldUps are exported specifically for direct unit
// testing with hand-built {seat, card}[] tricks — the same pattern
// packages/core/test/core.test.ts uses for trickWinner — since this is the
// most algorithmically involved logic in the stats-page expansion batch.
describe('ruffs', () => {
  const contract = (strain: number, declarer: Seat): Contract => ({
    level: 1,
    strain: strain as Contract['strain'],
    declarer,
    doubled: false,
    redoubled: false,
  });
  const emptyRuffs = () => ({
    declarerDummy: { plain: 0, over: 0, under: 0 },
    defense: { plain: 0, over: 0, under: 0 },
  });

  it('counts a plain ruff for the declaring side', () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 0); // hearts trump, North declares (N-S side)
    const trick = [
      { seat: 1 as Seat, card: makeCard(0, 5) }, // East leads a spade
      { seat: 2 as Seat, card: makeCard(1, 0) }, // South (human) ruffs with H2
      { seat: 3 as Seat, card: makeCard(0, 8) },
      { seat: 0 as Seat, card: makeCard(0, 10) },
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.declarerDummy).toEqual({ plain: 1, over: 0, under: 0 });
    expect(ruffs.defense).toEqual({ plain: 0, over: 0, under: 0 });
  });

  it('counts an over-ruff when the human beats an earlier (uncounted) opponent ruff', () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 0); // hearts trump, N-S declaring
    const trick = [
      { seat: 1 as Seat, card: makeCard(0, 5) }, // East leads a spade
      { seat: 3 as Seat, card: makeCard(1, 0) }, // West ruffs low (H2) — not human-controlled
      { seat: 0 as Seat, card: makeCard(0, 8) },
      { seat: 2 as Seat, card: makeCard(1, 5) }, // South over-ruffs with H7
    ];
    accumulateRuffs(ruffs, c, [trick]);
    // West's own ruff is never attributed to a bucket, even though it updates
    // the running best-trump used to classify South's later play
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 1, under: 0 });
  });

  it('counts an under-ruff when the human ruffs lower than an earlier opponent ruff', () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 0);
    const trick = [
      { seat: 1 as Seat, card: makeCard(0, 5) }, // East leads a spade
      { seat: 3 as Seat, card: makeCard(1, 10) }, // West ruffs high (HQ)
      { seat: 0 as Seat, card: makeCard(0, 8) },
      { seat: 2 as Seat, card: makeCard(1, 2) }, // South under-ruffs with H4
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 0, under: 1 });
  });

  it('buckets a human ruff made while defending separately from declaring', () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 1); // hearts trump, East declares — N-S is defending
    const trick = [
      { seat: 0 as Seat, card: makeCard(0, 5) }, // North leads a spade
      { seat: 2 as Seat, card: makeCard(1, 0) }, // South (human) ruffs while defending
      { seat: 1 as Seat, card: makeCard(0, 8) },
      { seat: 3 as Seat, card: makeCard(0, 10) },
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.defense).toEqual({ plain: 1, over: 0, under: 0 });
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 0, under: 0 });
  });

  it("does not count North's ruff while defending when N-S isn't declaring (humanControls false)", () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 1); // hearts trump, East declares — North is only a robot defender here
    const trick = [
      { seat: 3 as Seat, card: makeCard(0, 5) }, // West leads a spade
      { seat: 0 as Seat, card: makeCard(1, 0) }, // North ruffs — a robot's defensive ruff
      { seat: 1 as Seat, card: makeCard(0, 8) },
      { seat: 2 as Seat, card: makeCard(0, 10) },
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 0, under: 0 });
    expect(ruffs.defense).toEqual({ plain: 0, over: 0, under: 0 });
  });

  it('ignores a trump-led trick entirely — following/discarding trump is never a ruff', () => {
    const ruffs = emptyRuffs();
    const c = contract(2, 0);
    const trick = [
      { seat: 1 as Seat, card: makeCard(1, 5) }, // East leads trump (hearts)
      { seat: 2 as Seat, card: makeCard(1, 0) }, // South follows trump
      { seat: 3 as Seat, card: makeCard(1, 8) },
      { seat: 0 as Seat, card: makeCard(1, 10) },
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 0, under: 0 });
    expect(ruffs.defense).toEqual({ plain: 0, over: 0, under: 0 });
  });

  it('is a no-op for notrump contracts', () => {
    const ruffs = emptyRuffs();
    const c = contract(4, 0); // NT
    const trick = [
      { seat: 1 as Seat, card: makeCard(0, 5) },
      { seat: 2 as Seat, card: makeCard(1, 0) },
      { seat: 3 as Seat, card: makeCard(0, 8) },
      { seat: 0 as Seat, card: makeCard(0, 10) },
    ];
    accumulateRuffs(ruffs, c, [trick]);
    expect(ruffs.declarerDummy).toEqual({ plain: 0, over: 0, under: 0 });
    expect(ruffs.defense).toEqual({ plain: 0, over: 0, under: 0 });
  });
});

describe('hold-ups', () => {
  const contract = (strain: number, declarer: Seat): Contract => ({
    level: 3,
    strain: strain as Contract['strain'],
    declarer,
    doubled: false,
    redoubled: false,
  });
  // Only deal.hands[seat] is read by accumulateHoldUps — a minimal synthetic
  // deal naming just the cards each test needs is enough, no dealBoard() call.
  const deal = (hands: Partial<Record<Seat, number[]>>): Deal => ({
    hands: [0, 1, 2, 3].map((s) => hands[s as Seat] ?? []),
    dealer: 0,
    vul: { ns: false, ew: false },
  });

  it('records a genuine duck as an opportunity taken', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 0); // NT, North declares (N-S side)
    const d = deal({ 2: [makeCard(0, 12)] }); // South holds the actual ♠A
    const trick = [
      { seat: 3 as Seat, card: makeCard(0, 3) }, // West (defense) leads a spade
      { seat: 0 as Seat, card: makeCard(0, 6) },
      { seat: 1 as Seat, card: makeCard(0, 9) },
      { seat: 2 as Seat, card: makeCard(0, 4) }, // South ducks — plays low, not the ace
    ];
    accumulateHoldUps(holdUps, d, c, [trick]);
    expect(holdUps).toEqual({ opportunities: 1, taken: 1 });
  });

  it('records an opportunity not taken when the ace is played immediately', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 0);
    const d = deal({ 2: [makeCard(0, 12)] });
    const trick = [
      { seat: 3 as Seat, card: makeCard(0, 3) },
      { seat: 0 as Seat, card: makeCard(0, 6) },
      { seat: 1 as Seat, card: makeCard(0, 9) },
      { seat: 2 as Seat, card: makeCard(0, 12) }, // South takes it outright
    ];
    accumulateHoldUps(holdUps, d, c, [trick]);
    expect(holdUps).toEqual({ opportunities: 1, taken: 0 });
  });

  it('only counts the first lead of a suit, not a later one', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 0);
    const d = deal({ 2: [makeCard(0, 12)] });
    const firstLead = [
      { seat: 3 as Seat, card: makeCard(0, 3) },
      { seat: 0 as Seat, card: makeCard(0, 6) },
      { seat: 1 as Seat, card: makeCard(0, 9) },
      { seat: 2 as Seat, card: makeCard(0, 4) }, // duck — opportunity #1
    ];
    const secondLead = [
      { seat: 1 as Seat, card: makeCard(0, 7) }, // defense leads spades again
      { seat: 2 as Seat, card: makeCard(0, 12) }, // South now has to take the ace
      { seat: 3 as Seat, card: makeCard(0, 8) },
      { seat: 0 as Seat, card: makeCard(0, 2) },
    ];
    accumulateHoldUps(holdUps, d, c, [firstLead, secondLead]);
    expect(holdUps).toEqual({ opportunities: 1, taken: 1 });
  });

  it('records no opportunity when N-S leads the suit themselves', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 0);
    const d = deal({ 2: [makeCard(0, 12)] });
    const trick = [
      { seat: 0 as Seat, card: makeCard(0, 5) }, // North (N-S) leads the suit
      { seat: 1 as Seat, card: makeCard(0, 8) },
      { seat: 2 as Seat, card: makeCard(0, 4) },
      { seat: 3 as Seat, card: makeCard(0, 2) },
    ];
    accumulateHoldUps(holdUps, d, c, [trick]);
    expect(holdUps).toEqual({ opportunities: 0, taken: 0 });
  });

  it('is a no-op for suit contracts even with a textbook duck shape', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(2, 0); // hearts, not NT
    const d = deal({ 2: [makeCard(0, 12)] });
    const trick = [
      { seat: 3 as Seat, card: makeCard(0, 3) },
      { seat: 0 as Seat, card: makeCard(0, 6) },
      { seat: 1 as Seat, card: makeCard(0, 9) },
      { seat: 2 as Seat, card: makeCard(0, 4) },
    ];
    accumulateHoldUps(holdUps, d, c, [trick]);
    expect(holdUps).toEqual({ opportunities: 0, taken: 0 });
  });

  it('is a no-op when E-W declares, even at notrump', () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 1); // NT, East declares
    const d = deal({ 2: [makeCard(0, 12)] });
    const trick = [
      { seat: 3 as Seat, card: makeCard(0, 3) },
      { seat: 0 as Seat, card: makeCard(0, 6) },
      { seat: 1 as Seat, card: makeCard(0, 9) },
      { seat: 2 as Seat, card: makeCard(0, 4) },
    ];
    accumulateHoldUps(holdUps, d, c, [trick]);
    expect(holdUps).toEqual({ opportunities: 0, taken: 0 });
  });

  it("resolves the true top remaining card, not one already discarded away earlier", () => {
    const holdUps = { opportunities: 0, taken: 0 };
    const c = contract(4, 2); // NT, South declares (N-S side)
    // North holds the ♠K (the true top once the ace below is gone); South
    // deliberately doesn't hold the ♠Q, so South's own turn in the second
    // trick can't add a second opportunity for the same suit (see the
    // accumulateHoldUps doc comment on the rare double-opportunity case).
    const d = deal({ 0: [makeCard(0, 11)], 2: [] });
    const earlierUnrelatedTrick = [
      { seat: 0 as Seat, card: makeCard(3, 5) }, // North (N-S) leads clubs — never a hold-up trick
      { seat: 1 as Seat, card: makeCard(3, 8) },
      { seat: 2 as Seat, card: makeCard(0, 12) }, // South discards the ♠A away, void in clubs
      { seat: 3 as Seat, card: makeCard(3, 10) },
    ];
    const spadeLead = [
      { seat: 3 as Seat, card: makeCard(0, 3) }, // West (defense) leads spades for the first time
      { seat: 0 as Seat, card: makeCard(0, 11) }, // North holds and plays the now-true-top ♠K
      { seat: 1 as Seat, card: makeCard(0, 6) },
      { seat: 2 as Seat, card: makeCard(0, 2) }, // South follows low, holds no honor here
    ];
    accumulateHoldUps(holdUps, d, c, [earlierUnrelatedTrick, spadeLead]);
    // North's opportunity resolved against the ♠K (the ace was already gone),
    // and North played it outright rather than ducking
    expect(holdUps).toEqual({ opportunities: 1, taken: 0 });
  });
});

describe('classifyOpeningLead', () => {
  it('classifies top of sequence: led rank plus the next-lower rank both held', () => {
    // K-Q-x: lead the K (rank 11), Q (rank 10) also held
    expect(classifyOpeningLead(11, [11, 10, 0])).toBe('topOfSequence');
  });
  it('classifies fourth best: exactly the 4th-highest of a 4+ card holding, no sequence', () => {
    // K-J-8-5-3: lead the 5 (rank 3), the 4th-highest; rank 2 ('4') not held
    expect(classifyOpeningLead(3, [11, 9, 6, 3, 1])).toBe('fourthBest');
  });
  it('falls to other on a short, non-sequence holding', () => {
    // 9-5-2: lead the 5 (rank 3); only 3 cards, and rank 2 not held
    expect(classifyOpeningLead(3, [7, 3, 0])).toBe('other');
  });
  it('prioritizes sequence over fourth-best when both could apply', () => {
    // K-Q-J-9-8: lead the 9 (rank 7) — it's the 4th-highest AND 8 (rank 6) is held
    expect(classifyOpeningLead(7, [11, 10, 9, 7, 6])).toBe('topOfSequence');
  });
  it('does not classify fourth-best on a 3-card or shorter holding, even at a matching index', () => {
    expect(classifyOpeningLead(0, [7, 4, 0])).toBe('other');
  });
});
