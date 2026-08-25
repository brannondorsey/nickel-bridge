import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

const silentLog = { info() {}, error() {}, warn() {}, debug() {} } as unknown as FastifyBaseLogger;

/**
 * Demo-mode routes (DEMO=1): the /demo front door, the scenario API, reset,
 * and — critically — placement isolation: exhibit tournaments must never
 * leak into /api/play's resume or grace tiers.
 */
freshDbEnv('demo');
process.env.DEMO = '1';
const app = await makeApp();
const { db } = await import('../src/db.js');

describe('demo mode', () => {
  const inspector = new TestClient(app, 'unused');

  it('GET /demo signs in as Inspector and redirects to the gallery', async () => {
    const res = await inspector.raw('GET', '/demo');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/scenarios');
    expect(res.headers['set-cookie']).toBeDefined();
    const me = await inspector.get('/api/me');
    expect(me.demo).toBe(true);
    expect(me.user.handle).toBe('Inspector');
  });

  it('lists the scenario catalog', async () => {
    const { scenarios, newCrosserId, richProfileId, collisionHandle } = await inspector.get('/api/demo/scenarios');
    expect(scenarios.length).toBeGreaterThan(0);
    const one = scenarios.find((s: { id: string }) => s.id === 'your-call');
    expect(one).toMatchObject({ label: expect.any(String), description: expect.any(String), category: 'bidding' });
    // the wire shape is presentation-only — no seeds or action lists leak
    expect(Object.keys(one).sort()).toEqual(['category', 'description', 'id', 'label']);
    // the two profile-exhibit personas and the guaranteed-taken handle exist
    // synchronously, on the very first request — no seeder timing dependency
    expect(Number.isInteger(newCrosserId)).toBe(true);
    expect(Number.isInteger(richProfileId)).toBe(true);
    expect(collisionHandle).toBe('New Crosser');
  });

  it('the New Crosser is a permanent, always-empty persona', async () => {
    const { newCrosserId } = await inspector.get('/api/demo/scenarios');
    const stats = await inspector.get(`/api/users/${newCrosserId}/stats`);
    expect(stats.totals.boardsCompleted).toBe(0);
  });

  it('the rich profile points at a bot with genuine played history', async () => {
    // seedDemo is normally fired in the background on boot (index.ts) — this
    // test drives it directly, on a tiny profile that still names the same
    // bot (Margaret) the rich-profile exhibit looks up, so her stats page is
    // populated the way a preview deployment's would be after boot seeding.
    const seeder = await import('../src/demo-seed.js');
    await seeder.seedDemo(silentLog, {
      bots: ['Margaret'],
      tournaments: [{ seed: 'demo-test-rich', ageS: 86400, players: [0] }],
      exhibitFields: false,
    });
    const { richProfileId } = await inspector.get('/api/demo/scenarios');
    const stats = await inspector.get(`/api/users/${richProfileId}/stats`);
    expect(stats.totals.boardsCompleted).toBeGreaterThan(0);
  }, 120_000);

  it('DEMO=1 relaxes the leaderboard provisional quota to 1, not the production 4', async () => {
    // The boot seeder's DEFAULT_PROFILE plays each bot through at most 2
    // tournaments — well under the production quota (4) — so without this
    // override every preview's and the demo app's leaderboard would render
    // permanently empty. A 2-bot, 1-tournament seed here exercises the same
    // gap cheaply instead of running the full (deploy-scale) profile.
    const seeder = await import('../src/demo-seed.js');
    await seeder.seedDemo(silentLog, {
      bots: ['ProvisionalBotA', 'ProvisionalBotB'],
      tournaments: [{ seed: 'demo-test-provisional', ageS: 86400, players: [0, 1] }],
      exhibitFields: false,
    });
    const { leaderboard, provisionalMin } = await inspector.get('/api/leaderboard');
    expect(provisionalMin).toBe(1);
    const handles = (leaderboard as { handle: string }[]).map((r) => r.handle);
    expect(handles).toContain('ProvisionalBotA');
    expect(handles).toContain('ProvisionalBotB');
  }, 120_000);

  it('DEMO=1 relaxes /api/me\'s provisionalMin too, so the medal rail\'s club-tier copy stays honest', async () => {
    // Same quota as the leaderboard test above (server/src/tournaments.ts's
    // provisionalMin(), the one place both routes read DEMO from) — sent on
    // /api/me so MedalBar.tsx can tell whether "...to join the rankings" is
    // still true on this deployment before the club medal is even earned.
    const me = await inspector.get('/api/me');
    expect(me.provisionalMin).toBe(1);
  });

  it('the handle-collision exhibit prefill is guaranteed to 409', async () => {
    const { collisionHandle } = await inspector.get('/api/demo/scenarios');
    const visitor = new TestClient(app, 'Handle Collision Visitor');
    await visitor.post('/auth/dev', { name: visitor.name });
    const res = await visitor.raw('POST', '/api/handle', { handle: collisionHandle });
    expect(res.statusCode).toBe(409);
  });

  it('runs a scenario and lands the board in its expected state', async () => {
    const { tournamentId, boardNo } = await inspector.post('/api/demo/scenarios/your-call');
    const view = await inspector.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
    expect(view.state).toBe('bidding');
    expect(view.myTurn).toBe(true);
  }, 60_000);

  it('desync moves the caller’s own board on, so their next play is refused', async () => {
    // The stale-board exhibit's server half. Nothing about this is a special
    // code path — it plays through the same submitPlay a second tab would, so
    // the refusal the tester then sees is a genuine one.
    const { tournamentId, boardNo } = await inspector.post('/api/demo/scenarios/stale-board');
    const before = await inspector.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
    expect(before.state).toBe('playing');
    expect(before.myTurn).toBe(true);
    const card = before.legalCards[0];

    expect(await inspector.post('/api/demo/desync', { tournamentId, boardNo })).toEqual({ advanced: true });

    // the board really moved: replaying the card the stale screen still holds
    // is exactly what Board.tsx's resync notice exists for
    const refused = await inspector.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/play`, { card });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    // And the exhibit is reliable for a tester tapping ANY card, not just the
    // one this test picked: the two legal sets have to be disjoint, or some
    // taps would quietly succeed and the exhibit would show nothing. This is
    // deterministic (fixed recipe, deterministic robots, desync always plays
    // legalCards[0]) but not self-evident, so it is pinned — a deliberate
    // robot change that made them overlap would otherwise degrade the exhibit
    // silently rather than failing here.
    const after = await inspector.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
    expect(after.myTurn).toBe(true);
    expect(before.legalCards.filter((c: number) => after.legalCards.includes(c))).toEqual([]);
  }, 120_000);

  it('desync answers rather than erroring when there is nothing left to play', async () => {
    // a board the Inspector has never opened — no row, so nothing to move on
    const { tournamentId } = await inspector.post('/api/demo/scenarios/stale-board');
    expect(await inspector.post('/api/demo/desync', { tournamentId, boardNo: 4 })).toEqual({ advanced: false });
    expect((await inspector.raw('POST', '/api/demo/desync', { tournamentId })).statusCode).toBe(400);
    expect((await inspector.raw('POST', '/api/demo/desync', { tournamentId: 999999, boardNo: 1 })).statusCode).toBe(404);
  }, 120_000);

  it('drift has a real bot finish the caller’s last crossing, moving their rating', async () => {
    // Home's rating-drift exhibit. Like desync, this is not a special code
    // path: a seeded bot plays the four boards through the ordinary engine,
    // the field is re-matchpointed with one more pair in it, and the
    // Inspector's rating moves without them touching a card.
    const placed = await inspector.post('/api/play');
    for (let no = 1; no <= 4; no++) await playBoard(inspector, placed.tournamentId, no);
    const before = await inspector.get('/api/me');
    expect(before.user.eloDrift).toBe(0);

    const res = await inspector.post('/api/demo/drift');
    expect(res.drifted).toBe(true);

    const after = await inspector.get('/api/me');
    expect(after.user.ratedTournaments).toBeGreaterThan(0);
    // the rating moved, and the tile's delta is exactly that movement
    expect(after.user.elo).not.toBe(before.user.elo);
    expect(after.user.eloDrift).toBe(after.user.elo - before.user.elo);
  }, 300_000);

  // DEMO=1 hands every visitor the SAME Inspector session, so two testers
  // clicking this at once really are two concurrent requests for one user.
  // Unserialized they both pick the same passer — neither has finished a board
  // yet, so nothing tells them apart — and playThrough's wipe-unfinished step
  // deletes the other's in-flight board out from under it.
  it('serializes concurrent passes, so each takes a different bot', async () => {
    const twice = new TestClient(app, 'DriftTwice');
    await twice.login();
    const placed = await twice.post('/api/play');
    for (let no = 1; no <= 4; no++) await playBoard(twice, placed.tournamentId, no);

    const [a, b] = await Promise.all([twice.post('/api/demo/drift'), twice.post('/api/demo/drift')]);
    expect(a.drifted).toBe(true);
    expect(b.drifted).toBe(true);

    // Two DISTINCT passers, each with a whole crossing done. Both halves have
    // teeth: unserialized, the two requests cannot tell the passers apart and
    // both take the FIRST one (so only one shows up here), and the loser's
    // in-flight board is wiped mid-play (so a passer can be left short of
    // four). Placement joins an existing field, so this counts passers rather
    // than every finisher of the crossing.
    const passers = db
      .prepare(
        `SELECT b.user_id, COUNT(*) AS n FROM boards b JOIN users u ON u.id = b.user_id
          WHERE b.tournament_id = ? AND b.state = 'done' AND u.handle LIKE '%Passer%'
          GROUP BY b.user_id`,
      )
      .all(placed.tournamentId) as { user_id: number; n: number }[];
    expect(passers.length).toBeGreaterThanOrEqual(2);
    for (const p of passers) expect(p.n).toBe(4);
  }, 300_000);

  it('drift answers rather than erroring when there is no crossing to move', async () => {
    const newcomer = new TestClient(app, 'DriftNewcomer');
    await newcomer.login();
    expect(await newcomer.post('/api/demo/drift')).toEqual({ drifted: false });
  });

  it('re-entering a scenario resets the board instead of stacking on it', async () => {
    const first = await inspector.post('/api/demo/scenarios/partner-declares');
    const v1 = await inspector.get(`/api/tournaments/${first.tournamentId}/boards/${first.boardNo}`);
    const again = await inspector.post('/api/demo/scenarios/partner-declares');
    expect(again.tournamentId).toBe(first.tournamentId);
    const v2 = await inspector.get(`/api/tournaments/${again.tournamentId}/boards/${again.boardNo}`);
    expect(v2.state).toBe('playing');
    expect(v2.auction.length).toBe(v1.auction.length);
    expect(v2.completedTricks).toBe(v1.completedTricks);
  }, 120_000);

  it('404s an unknown scenario id', async () => {
    const res = await inspector.raw('POST', '/api/demo/scenarios/no-such-exhibit');
    expect(res.statusCode).toBe(404);
  });

  it('keeps exhibit tournaments out of placement and the lobby for everyone', async () => {
    // The Inspector has unfinished exhibit boards from the tests above
    // (their ids come back from the scenario API)...
    const exhibitIds = new Set<number>();
    for (const id of ['your-call', 'partner-declares']) {
      exhibitIds.add((await inspector.post(`/api/demo/scenarios/${id}`)).tournamentId);
    }
    expect(exhibitIds.size).toBeGreaterThan(0);

    // ...but they never surface in the lobby list (kind = 'exhibit')...
    const { tournaments } = await inspector.get('/api/tournaments');
    for (const t of tournaments as { id: number }[]) expect(exhibitIds.has(t.id)).toBe(false);

    // ...the resume tier must NOT hand them back on PLAY THE TOLL...
    const placed = await inspector.post('/api/play');
    expect(exhibitIds.has(placed.tournamentId)).toBe(false);

    // ...and young, under-filled exhibits must not grace-capture a stranger.
    const visitor = new TestClient(app, 'Visitor');
    await visitor.login();
    const visitorPlaced = await visitor.post('/api/play');
    expect(exhibitIds.has(visitorPlaced.tournamentId)).toBe(false);
  }, 120_000);

  it('reset wipes the database and keeps the requester signed in', async () => {
    // registered users, not the (now provisional-gated) leaderboard list —
    // neither Inspector nor Visitor has completed enough rated tournaments to
    // appear there, so this checks the underlying wipe directly.
    const userCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE handle IS NOT NULL`).get() as { n: number }).n;
    expect(userCount()).toBeGreaterThan(1); // Inspector + Visitor
    await inspector.post('/api/demo/reset', { reseed: false });
    const me = await inspector.get('/api/me'); // works: fresh cookie from the reset response
    expect(me.user.handle).toBe('Inspector');
    expect(userCount()).toBe(1);
    const { tournaments } = await inspector.get('/api/tournaments');
    expect(tournaments.length).toBe(0);
  });
});
