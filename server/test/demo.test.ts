import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp } from './helpers.js';

/**
 * Demo-mode routes (DEMO=1): the /demo front door, the scenario API, reset,
 * and — critically — placement isolation: exhibit tournaments must never
 * leak into /api/play's resume or grace tiers.
 */
freshDbEnv('demo');
process.env.DEMO = '1';
const app = await makeApp();

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
    const { scenarios } = await inspector.get('/api/demo/scenarios');
    expect(scenarios.length).toBeGreaterThan(0);
    const one = scenarios.find((s: { id: string }) => s.id === 'your-call');
    expect(one).toMatchObject({ label: expect.any(String), description: expect.any(String), category: 'bidding' });
    // the wire shape is presentation-only — no seeds or action lists leak
    expect(Object.keys(one).sort()).toEqual(['category', 'description', 'id', 'label']);
  });

  it('runs a scenario and lands the board in its expected state', async () => {
    const { tournamentId, boardNo } = await inspector.post('/api/demo/scenarios/your-call');
    const view = await inspector.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
    expect(view.state).toBe('bidding');
    expect(view.myTurn).toBe(true);
  }, 60_000);

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

  it('keeps exhibit tournaments out of placement for everyone', async () => {
    // The Inspector has unfinished exhibit boards from the tests above: the
    // resume tier must NOT hand them back on PLAY THE TOLL...
    const { tournaments } = await inspector.get('/api/tournaments');
    const exhibitIds = new Set<number>(tournaments.map((t: { id: number }) => t.id));
    expect(exhibitIds.size).toBeGreaterThan(0);
    const placed = await inspector.post('/api/play');
    expect(exhibitIds.has(placed.tournamentId)).toBe(false);

    // ...and young, under-filled exhibits must not grace-capture a stranger.
    const visitor = new TestClient(app, 'Visitor');
    await visitor.login();
    const visitorPlaced = await visitor.post('/api/play');
    expect(exhibitIds.has(visitorPlaced.tournamentId)).toBe(false);
  });

  it('reset wipes the database and keeps the requester signed in', async () => {
    const before = await inspector.get('/api/leaderboard');
    expect(before.leaderboard.length).toBeGreaterThan(1); // Inspector + Visitor
    await inspector.post('/api/demo/reset', { reseed: false });
    const me = await inspector.get('/api/me'); // works: fresh cookie from the reset response
    expect(me.user.handle).toBe('Inspector');
    const after = await inspector.get('/api/leaderboard');
    expect(after.leaderboard.length).toBe(1);
    const { tournaments } = await inspector.get('/api/tournaments');
    expect(tournaments.length).toBe(0);
  });
});
