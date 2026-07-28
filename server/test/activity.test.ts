import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('activity');

/**
 * The activity feed's server half. What's under test here is the filtering and
 * the shape of the events — the grouping into local days and parts of the day
 * happens in the browser (see src/activity.ts's header note) and is covered by
 * web/src/pages/activityFeed.test.ts.
 */
let app: FastifyInstance;
let db: typeof import('../src/db.js').db;

type Event = { kind: string; userId: number; at: number; [k: string]: unknown };

beforeAll(async () => {
  app = await makeApp();
  ({ db } = await import('../src/db.js'));
});

const eventsOf = (payload: { events: Event[] }, kind: string) => payload.events.filter((e) => e.kind === kind);

/** Play a user through a whole tournament, returning its id. */
async function crossOnce(client: TestClient): Promise<number> {
  const { tournamentId } = await client.post('/api/play');
  for (let no = 1; no <= 4; no++) await playBoard(client, tournamentId, no);
  return tournamentId;
}

describe('GET /api/activity', () => {
  it('refuses a caller with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    expect(res.statusCode).toBe(401);
  });

  it('reports a completed crossing with its boards, place and rating change', async () => {
    const alice = new TestClient(app, 'ActivityAlice');
    const bob = new TestClient(app, 'ActivityBob');
    await alice.login();
    await bob.login();

    const tid = await crossOnce(alice);
    // A second human in the same field is what makes the tournament rate.
    for (let no = 1; no <= 4; no++) await playBoard(bob, tid, no);

    const payload = await alice.get('/api/activity');

    const aliceId = payload.players ? Number(Object.keys(payload.players).find((id) => payload.players[id].handle === 'ActivityAlice')) : NaN;
    expect(Number.isNaN(aliceId)).toBe(false);

    // One 'board' event per completed board — the grain the client buckets by.
    expect(eventsOf(payload, 'board').filter((e) => e.userId === aliceId)).toHaveLength(4);

    const crossing = eventsOf(payload, 'crossing').find((e) => e.userId === aliceId)!;
    expect(crossing).toBeDefined();
    expect(crossing.tournamentId).toBe(tid);
    expect(typeof crossing.pct).toBe('number');
    expect(crossing.rank).toBeGreaterThanOrEqual(1);
    expect(crossing.of).toBeGreaterThanOrEqual(2);
    // Two humans finished, so this one rated.
    expect(crossing.eloDelta).not.toBeNull();

    // Their arrival is in the window too.
    expect(eventsOf(payload, 'joined').some((e) => e.userId === aliceId)).toBe(true);
  });

  it('takes every eloDelta straight from elo_history, or null when there is no row', async () => {
    const solo = new TestClient(app, 'ActivitySolo');
    await solo.login();
    await crossOnce(solo);

    // Placement decides which field anyone lands in, so the test can't dictate
    // whether a given tournament rated. It can hold the mapping to account:
    // a delta is `after - before` when a rating row exists and null when it
    // doesn't — never a 0 standing in for "this didn't rate".
    const payload = await solo.get('/api/activity');
    const crossings = eventsOf(payload, 'crossing');
    expect(crossings.length).toBeGreaterThan(0);
    for (const c of crossings) {
      const row = db
        .prepare(`SELECT before, after FROM elo_history WHERE user_id = ? AND tournament_id = ?`)
        .get(c.userId, c.tournamentId) as { before: number; after: number } | undefined;
      expect(c.eloDelta).toBe(row ? row.after - row.before : null);
    }
  });

  it('reports null for a crossing that rated nobody', async () => {
    const client = new TestClient(app, 'ActivityUnrated');
    await client.login();
    const tid = await crossOnce(client);

    // A field with fewer than two human finishers produces no elo_history row
    // at all (eloParticipants). Clearing the rows reproduces that state exactly
    // — recomputeElo only runs on the next completion, so nothing rebuilds them
    // under the request being asserted.
    db.prepare(`DELETE FROM elo_history WHERE tournament_id = ?`).run(tid);

    const payload = await client.get('/api/activity');
    const crossing = eventsOf(payload, 'crossing').find((e) => e.tournamentId === tid)!;
    expect(crossing).toBeDefined();
    expect(crossing.eloDelta).toBeNull();
  });

  it('leaves the house out of it', async () => {
    const client = new TestClient(app, 'ActivityNoHouse');
    await client.login();
    // Personas are created lazily by ai-players.ts; assert against whatever
    // 'ai' rows exist rather than assuming there are none.
    db.prepare(
      `INSERT INTO users (google_id, name, handle, handle_key, kind) VALUES ('ai:test', 'The Test', 'The Test', 'the test', 'ai')`,
    ).run();
    const aiId = (db.prepare(`SELECT id FROM users WHERE google_id = 'ai:test'`).get() as { id: number }).id;

    const payload = await client.get('/api/activity');
    expect(payload.players[String(aiId)]).toBeUndefined();
    expect(payload.events.some((e: Event) => e.userId === aiId)).toBe(false);
  });

  it('excludes boards older than the window', async () => {
    const client = new TestClient(app, 'ActivityOld');
    await client.login();
    const tid = await crossOnce(client);

    const before = await client.get('/api/activity');
    expect(eventsOf(before, 'crossing').some((e) => e.tournamentId === tid)).toBe(true);

    // Backdate the whole tournament well past the window, the way demo-seed
    // does, and it should drop out entirely.
    db.prepare(`UPDATE boards SET updated_at = updated_at - ? WHERE tournament_id = ?`).run(30 * 86400, tid);
    const after = await client.get('/api/activity');
    expect(eventsOf(after, 'crossing').some((e) => e.tournamentId === tid)).toBe(false);
    expect(eventsOf(after, 'board').some((e) => e.userId === before.events[0].userId && e.at < 0)).toBe(false);
  });

  it('marks a player’s very first crossing as a milestone', async () => {
    const client = new TestClient(app, 'ActivityFirst');
    await client.login();
    await crossOnce(client);

    const payload = await client.get('/api/activity');
    const id = Number(Object.keys(payload.players).find((k) => payload.players[k].handle === 'ActivityFirst'));
    const milestones = eventsOf(payload, 'milestone').filter((e) => e.userId === id);
    expect(milestones.map((m) => m.milestone)).toContain('first-crossing');
  });

  it('honours the provisional quota it is given, so demo and production agree', async () => {
    const client = new TestClient(app, 'ActivityLadder');
    await client.login();
    await crossOnce(client);

    const { recentActivity } = await import('../src/activity.js');
    const since = Math.floor(Date.now() / 1000) - 8 * 86400;
    const id = (db.prepare(`SELECT id FROM users WHERE handle = 'ActivityLadder'`).get() as { id: number }).id;
    const ladderFor = (quota: number) =>
      recentActivity(since, quota).events.filter(
        (e) => e.kind === 'milestone' && e.userId === id && e.milestone === 'entered-rankings',
      );

    // The quota is a real input, not a baked-in constant: DEMO=1 relaxes it to
    // 1 because the seeder's bots never reach the production 4, and hardcoding
    // it made this milestone unreachable in demo and on every PR preview.
    expect(ladderFor(1)).toHaveLength(1);
    expect(ladderFor(4)).toHaveLength(0);
  });

  it('never mentions a player who has not picked a handle', async () => {
    // /auth/dev creates the account; skipping /api/handle leaves it nameless.
    const res = await app.inject({ method: 'POST', url: '/auth/dev', payload: { name: 'Nameless' } });
    expect(res.statusCode).toBe(200);
    const nameless = db.prepare(`SELECT id FROM users WHERE handle IS NULL ORDER BY id DESC LIMIT 1`).get() as
      | { id: number }
      | undefined;
    expect(nameless).toBeDefined();

    const client = new TestClient(app, 'ActivityWitness');
    await client.login();
    const payload = await client.get('/api/activity');
    expect(payload.players[String(nameless!.id)]).toBeUndefined();
    expect(payload.events.some((e: Event) => e.userId === nameless!.id)).toBe(false);
  });
});
