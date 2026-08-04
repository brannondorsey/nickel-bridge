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

  it('does not re-fire entered-rankings when a long-abandoned tournament backfills into the rating series', async () => {
    // Reproduces a reported false positive: a veteran player (already on the
    // ladder for a long time) resumes and finishes a tournament they'd left
    // unfinished ages ago (tournaments never close). Its elo_history row only
    // appears today, but its tournament_id is lower than the tournament that
    // genuinely took this player over the quota — so indexing elo_history's
    // tournament_id-ordered series directly picks the wrong "quota-th" crossing
    // and re-announces 'entered-rankings' for someone long past it.
    const veteran = new TestClient(app, 'ActivityVeteran');
    const rater = new TestClient(app, 'ActivityVeteranRater');
    await veteran.login();
    await rater.login();

    const tid = await crossOnce(veteran);
    // A second human rates it — this is the crossing that actually put the
    // veteran on the ladder.
    for (let no = 1; no <= 4; no++) await playBoard(rater, tid, no);

    const veteranId = (db.prepare(`SELECT id FROM users WHERE handle = 'ActivityVeteran'`).get() as { id: number }).id;

    // Push that genuine milestone well outside the window.
    db.prepare(`UPDATE boards SET updated_at = updated_at - ? WHERE tournament_id = ?`).run(30 * 86400, tid);

    // Simulate the resumed-old-tournament backfill: a lower tournament_id
    // (so it sorts earlier in elo_history's replay order) whose boards and
    // rating row only land today.
    const oldTid = tid - 1_000_000;
    db.prepare(`INSERT INTO tournaments (id, name, seed, created_at) VALUES (?, 'Old Tournament', 'seed', ?)`).run(
      oldTid,
      Math.floor(Date.now() / 1000) - 400 * 86400,
    );
    for (let no = 1; no <= 4; no++) {
      db.prepare(
        `INSERT INTO boards (tournament_id, user_id, board_no, state, contract, tricks_declarer, score_ns, updated_at)
         VALUES (?, ?, ?, 'done', '{}', 0, 0, unixepoch())`,
      ).run(oldTid, veteranId, no);
    }
    db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, 1200, 1210)`).run(
      veteranId,
      oldTid,
    );

    const { recentActivity } = await import('../src/activity.js');
    const since = Math.floor(Date.now() / 1000) - 8 * 86400;
    const milestones = recentActivity(since, 1).events.filter(
      (e) => e.kind === 'milestone' && e.userId === veteranId && e.milestone === 'entered-rankings',
    );
    expect(milestones).toHaveLength(0);
  });

  it('announces a peak rating on the crossing the player finished last, not the highest-id one', async () => {
    // Same backfill shape as the test above, aimed at 'peak-rating'. The
    // ratings in elo_history are a running total over the REPLAY's id order, so
    // a resumed old crossing carries a figure computed as if the newer ones had
    // not happened; read that way, the sequence below has no new best in it at
    // all and the milestone silently never fires. Walked in play order and
    // rebuilt from each crossing's delta (as stats.ts's eloProgression does, so
    // the two surfaces can't print different peaks), the player's last crossing
    // is a genuine personal best.
    const climber = new TestClient(app, 'ActivityClimber');
    await climber.login();
    const uid = (db.prepare(`SELECT id FROM users WHERE handle = 'ActivityClimber'`).get() as { id: number }).id;

    const mkTournament = (name: string) =>
      (db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, 'seed') RETURNING id`).get(name) as { id: number })
        .id;
    const lowTid = mkTournament('climber-old'); // minted first, so the LOWER id...
    const highTid = mkTournament('climber-new');

    const now = Math.floor(Date.now() / 1000);
    const insertBoard = db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, contract, tricks_declarer, score_ns, updated_at)
       VALUES (?, ?, ?, 'done', '{}', 0, 0, ?)`,
    );
    // ...but finished LAST: the newer tournament three days ago, the resumed old one today.
    for (let no = 1; no <= 4; no++) insertBoard.run(highTid, uid, no, now - 3 * 86400);
    for (let no = 1; no <= 4; no++) insertBoard.run(lowTid, uid, no, now - 60);

    // Chain in id order: 1200 → 1250 (old, +50) → 1230 (new, −20). Nothing in
    // that sequence ever exceeds 1250 after the first crossing.
    const insertElo = db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`);
    insertElo.run(uid, lowTid, 1200, 1250);
    insertElo.run(uid, highTid, 1250, 1230);

    const { recentActivity } = await import('../src/activity.js');
    const peaks = recentActivity(now - 8 * 86400, 1).events.filter(
      (e) => e.kind === 'milestone' && e.userId === uid && e.milestone === 'peak-rating',
    );
    // Play order: −20 three days ago (1180), then +50 today (1230) — a best,
    // announced on the day it happened and worth the rating the player holds.
    expect(peaks).toHaveLength(1);
    expect(peaks[0].value).toBe(1230);
    expect(peaks[0].at).toBe(now - 60);
  });

  it('never announces a best rating lower than one it already announced earlier in the feed', async () => {
    // Reproduces a reported production symptom: the same player shown "a new
    // best rating — 1279" at 4:12p and then "a new best rating — 1266" at
    // 9:24p, a personal best three hours later and thirteen points lower.
    //
    // Nothing about the ratings was wrong — the walk was. The running best was
    // taken over elo_history's tournament-id order while each event was stamped
    // with the crossing's finish time, so the two disagreed the moment a player
    // resumed an old, low-id tournament: the values climb in replay order and
    // then get scattered across the wall clock the feed sorts by.
    const gs = new TestClient(app, 'ActivityPeakOrder');
    await gs.login();
    const uid = (db.prepare(`SELECT id FROM users WHERE handle = 'ActivityPeakOrder'`).get() as { id: number }).id;

    const mkTournament = (name: string) =>
      (db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, 'seed') RETURNING id`).get(name) as { id: number })
        .id;
    const t1 = mkTournament('peak-1');
    const t2 = mkTournament('peak-2'); // middle id, but finished LAST
    const t3 = mkTournament('peak-3'); // highest id, finished before t2

    const now = Math.floor(Date.now() / 1000);
    const at1 = now - 2 * 86400;
    const at3 = now - 5 * 3600; // "4:12p"
    const at2 = now - 2 * 3600; // "9:24p" — later in the day, lower id
    const insertBoard = db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, contract, tricks_declarer, score_ns, updated_at)
       VALUES (?, ?, ?, 'done', '{}', 0, 0, ?)`,
    );
    for (const [tid, at] of [
      [t1, at1],
      [t2, at2],
      [t3, at3],
    ] as const) {
      for (let no = 1; no <= 4; no++) insertBoard.run(tid, uid, no, at);
    }

    // Chain in id order climbs the whole way: 1200 → 1250 → 1266 → 1279.
    const insertElo = db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`);
    insertElo.run(uid, t1, 1200, 1250);
    insertElo.run(uid, t2, 1250, 1266);
    insertElo.run(uid, t3, 1266, 1279);

    const { recentActivity } = await import('../src/activity.js');
    const peaks = recentActivity(now - 8 * 86400, 99).events
      .filter((e) => e.kind === 'milestone' && e.userId === uid && e.milestone === 'peak-rating')
      .sort((a, b) => a.at - b.at);

    // The property that was violated, stated as a property: read down the feed
    // in the order a reader reads it, every announced best beats the last.
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].value as number).toBeGreaterThan(peaks[i - 1].value as number);
    }
    // Concretely: +13 in the afternoon (1263), +16 in the evening (1279), and
    // the last one is the rating they actually hold. Read in id order these
    // were announced as 1266 then 1279 — at 9:24p and 4:12p respectively.
    expect(peaks.map((e) => [e.at, e.value])).toEqual([
      [at3, 1263],
      [at2, 1279],
    ]);
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
