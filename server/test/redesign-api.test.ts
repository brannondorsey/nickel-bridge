import { beforeAll, describe, expect, it } from 'vitest';
import { freshDbEnv, makeApp, playBoard, TestClient } from './helpers.js';
// Type-only, so it is erased at compile time and never evaluates ../src/db.js
// before freshDbEnv() below has set DB_PATH — the whole reason every other
// import in this file is dynamic.
import type { TournamentRow } from '../src/db.js';

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
  // Two rated crossings for the pair, which the monthly-delta and tournament-
  // metadata blocks below both read. This used to be a side effect of the
  // movement tests, which no longer play any boards — an implicit dependency on
  // describe order that was one edit away from breaking silently.
  await completeTournament([alice, bob]);
  await completeTournament([alice, bob]);
});

const DAY = 86_400;
const NOW = 1_800_000_000;

/**
 * Fabricate a rated crossing that finished at a chosen instant: a standard
 * tournament, four done boards per player stamped `finishedAt`, and one
 * elo_history row each.
 *
 * Movement no longer depends on placement or on real play at all — it is a
 * function of (the visible rows the caller passes, what those players banked
 * inside the window). Fabricating lets these tests put a crossing at an exact
 * age, which is the whole point of a windowed arrow and is not otherwise
 * reachable: real play always finishes now.
 *
 * Note this must not be mixed with real board play in the same test. Any human
 * completing any board triggers recomputeElo, which wipes elo_history and
 * replays it — taking these fabricated rows with it.
 */
async function fabricateCrossing(players: { id: number; before: number; after: number }[], finishedAt: number) {
  const { db, createCrossing } = await import('../src/db.js');
  const t = createCrossing(
    () =>
      db
        .prepare(`INSERT INTO tournaments (name, seed, difficulty) VALUES (?, ?, 'perfect') RETURNING *`)
        .get('Tournament', `fab-${finishedAt}-${players.map((p) => p.id).join('-')}`) as TournamentRow,
  );
  // db.ts sets PRAGMA foreign_keys = ON and boards.user_id references users,
  // so a synthetic player has to exist before it can have played anything.
  const user = db.prepare(`INSERT OR IGNORE INTO users (id, google_id, name) VALUES (?, ?, ?)`);
  const board = db.prepare(
    `INSERT INTO boards (tournament_id, user_id, board_no, state, updated_at) VALUES (?, ?, ?, 'done', ?)`,
  );
  const rating = db.prepare(`INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`);
  for (const p of players) {
    user.run(p.id, `fab-user-${p.id}`, `Fab ${p.id}`);
    for (let no = 1; no <= 4; no++) board.run(t.id, p.id, no, finishedAt);
    rating.run(p.id, t.id, p.before, p.after);
  }
  return t.id;
}

describe('rank ordering', () => {
  it('shares a rank across ties and skips the next (standard competition ranking)', async () => {
    const { ranksOf } = await import('../src/tournaments.js');
    const ranks = ranksOf(
      new Map([
        [1, 1260],
        [2, 1210],
        [3, 1210],
        [4, 1190],
      ]),
    );
    expect([...ranks.entries()]).toEqual([
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 4],
    ]);
  });
});

/**
 * Movement is exercised through leaderboardMovement() directly rather than the
 * route: it now takes the visible ladder as an argument precisely so the two
 * can be tested apart, and reaching the route's own list would mean giving
 * every fixture player four rated crossings to clear the provisional quota.
 * One route-level test below pins the wiring.
 */
describe('leaderboard movement', () => {
  it('is empty when there is no visible ladder to rank', async () => {
    const { leaderboardMovement } = await import('../src/tournaments.js');
    expect(leaderboardMovement([], { nowSec: NOW, provisionalMin: 4 }).size).toBe(0);
  });

  it('never lets a player the reader cannot see move a visible arrow', async () => {
    // The reported bug, in miniature: a #2 on an eight-row ladder wearing ▼3
    // because players below the provisional quota had passed them. Hidden here
    // is a below-quota rocket who banked +300 inside the window and now
    // out-rates everyone; the two visible rows sat still.
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const hidden = 9101;
    await fabricateCrossing([{ id: hidden, before: 1200, after: 1500 }], NOW - 2 * DAY);

    const visible = [
      { id: 9102, elo: 1409, ratedTournaments: 9 },
      { id: 9103, elo: 1223, ratedTournaments: 9 },
    ];
    const movement = leaderboardMovement(visible, { nowSec: NOW, provisionalMin: 4 });
    expect(movement.get(9102)).toEqual({ oneDay: 0, sevenDay: 0 });
    expect(movement.get(9103)).toEqual({ oneDay: 0, sevenDay: 0 });
    expect(movement.has(hidden)).toBe(false);
  });

  it('does not credit an idle player for a newcomer arriving beneath them', async () => {
    // The phantom-1200 case. A player whose every rated crossing falls inside
    // the window reconstructs to exactly ELO_INITIAL at the cutoff; left in the
    // "then" population that ghost sits mid-ladder and displaces people. Here
    // the newcomer arrives at 1150, BELOW all three idle players — so if the
    // ghost were ranked, the 1190 player would read ▲1 for playing nothing.
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const [a, b, c, newcomer] = [9201, 9202, 9203, 9204];
    // four crossings so the newcomer clears the quota on paper, all inside the
    // window — which is exactly what leaves them no position at the cutoff
    for (let i = 0; i < 4; i++) {
      await fabricateCrossing([{ id: newcomer, before: 1200 - i * 12, after: 1200 - (i + 1) * 12 }], NOW - 2 * DAY);
    }

    const visible = [
      { id: a, elo: 1260, ratedTournaments: 9 },
      { id: b, elo: 1210, ratedTournaments: 9 },
      { id: c, elo: 1190, ratedTournaments: 9 },
      { id: newcomer, elo: 1152, ratedTournaments: 4 },
    ];
    const movement = leaderboardMovement(visible, { nowSec: NOW, provisionalMin: 4 });
    expect(movement.get(c)?.sevenDay).toBe(0);
    expect(movement.get(a)?.sevenDay).toBe(0);
    expect(movement.get(b)?.sevenDay).toBe(0);
    // and the newcomer has no position to have moved from
    expect(movement.get(newcomer)?.sevenDay).toBeNull();
  });

  it('reads an overtaking newcomer as a real drop for whoever they passed', async () => {
    // The other direction of the same rule: excluding a non-member from the
    // "then" ranking must not also hide a genuine overtake, because competition
    // ranking counts only the players ABOVE you.
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const [a, b, newcomer] = [9301, 9302, 9303];
    for (let i = 0; i < 4; i++) {
      await fabricateCrossing([{ id: newcomer, before: 1200 + i * 25, after: 1200 + (i + 1) * 25 }], NOW - 2 * DAY);
    }
    const visible = [
      { id: a, elo: 1260, ratedTournaments: 9 },
      { id: newcomer, elo: 1300, ratedTournaments: 4 },
      { id: b, elo: 1210, ratedTournaments: 9 },
    ];
    const movement = leaderboardMovement(visible, { nowSec: NOW, provisionalMin: 4 });
    expect(movement.get(a)?.sevenDay).toBe(-1);
    expect(movement.get(b)?.sevenDay).toBe(-1);
  });

  it('separates the one-day and seven-day windows', async () => {
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const [climber, faller] = [9401, 9402];
    // three days ago: inside the week, outside the day
    await fabricateCrossing(
      [
        { id: climber, before: 1200, after: 1260 },
        { id: faller, before: 1280, after: 1220 },
      ],
      NOW - 3 * DAY,
    );

    const visible = [
      { id: climber, elo: 1260, ratedTournaments: 9 },
      { id: faller, elo: 1220, ratedTournaments: 9 },
    ];
    const movement = leaderboardMovement(visible, { nowSec: NOW, provisionalMin: 4 });
    // over the week they swapped places; over the day nothing happened at all
    expect(movement.get(climber)).toEqual({ oneDay: 0, sevenDay: 1 });
    expect(movement.get(faller)).toEqual({ oneDay: 0, sevenDay: -1 });
  });

  it('ignores a crossing that finished before the window', async () => {
    const { leaderboardMovement } = await import('../src/tournaments.js');
    const [x, y] = [9501, 9502];
    await fabricateCrossing(
      [
        { id: x, before: 1200, after: 1300 },
        { id: y, before: 1300, after: 1200 },
      ],
      NOW - 30 * DAY,
    );
    const visible = [
      { id: x, elo: 1300, ratedTournaments: 9 },
      { id: y, elo: 1200, ratedTournaments: 9 },
    ];
    const movement = leaderboardMovement(visible, { nowSec: NOW, provisionalMin: 4 });
    expect(movement.get(x)).toEqual({ oneDay: 0, sevenDay: 0 });
    expect(movement.get(y)).toEqual({ oneDay: 0, sevenDay: 0 });
  });

  it('serves both windows on every leaderboard row', async () => {
    const { db } = await import('../src/db.js');
    // Four rated crossings apiece clears PROVISIONAL_MIN_TOURNAMENTS, which is
    // what it takes to appear in the route's list at all. A handle is the
    // other requirement (the route filters `handle IS NOT NULL`), and the
    // ratings have to be on the users row since that is where the route reads
    // the "now" side of the comparison from.
    const [p, q] = [9601, 9602];
    for (let i = 0; i < 4; i++) {
      await fabricateCrossing(
        [
          { id: p, before: 1200, after: 1310 },
          { id: q, before: 1200, after: 1290 },
        ],
        NOW - 3 * DAY,
      );
    }
    db.prepare(`UPDATE users SET handle = ?, handle_key = ?, elo = ? WHERE id = ?`).run('FabP', 'fabp', 1310, p);
    db.prepare(`UPDATE users SET handle = ?, handle_key = ?, elo = ? WHERE id = ?`).run('FabQ', 'fabq', 1290, q);

    const { leaderboard } = await alice.get('/api/leaderboard');
    const row = leaderboard.find((r: { id: number }) => r.id === p);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('movement'); // the old single-window field is gone
    expect(row.movement1d === null || typeof row.movement1d === 'number').toBe(true);
    expect(row.movement7d === null || typeof row.movement7d === 'number').toBe(true);
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

  // The per-player swings the finished tournament page draws in THE FIELD.
  // They are the whole field's version of myEloDelta above, so they have to
  // agree with it for the viewer's own row.
  it('detail carries a per-player eloDelta agreeing with myEloDelta', async () => {
    const { tournaments } = await alice.get('/api/tournaments');
    const finished = tournaments.find((t: { myDone: number }) => t.myDone === 4);
    const detail = await alice.get(`/api/tournaments/${finished.id}`);
    const aliceId = (await alice.get('/api/me')).user.id;

    const mine = detail.standings.find((s: { userId: number }) => s.userId === aliceId);
    expect(mine.eloDelta).toBe(detail.myEloDelta.after - detail.myEloDelta.before);

    // Every complete human of a rated crossing gets a row (recomputeElo inserts
    // one per participant), so none of them may report null.
    const humans = detail.standings.filter((s: { kind: string; complete: boolean }) => s.kind === 'human' && s.complete);
    expect(humans.length).toBeGreaterThanOrEqual(2);
    for (const s of humans) expect(typeof s.eloDelta).toBe('number');

    // Elo is zero-sum across the rated field, so the swings cancel. This also
    // pins that we are reading whole rows rather than one player's view of them.
    const total = humans.reduce((a: number, s: { eloDelta: number }) => a + s.eloDelta, 0);
    expect(Math.abs(total)).toBeLessThanOrEqual(humans.length); // ±1 per row for Math.round
  });

  it('reports eloDelta null for a crossing that has rated nobody', async () => {
    // One human, four boards: complete, but recomputeElo needs 2+ complete
    // humans to rate a crossing at all, so nobody in this field has a swing.
    //
    // Deliberately NOT via POST /api/play, for the same reason the late-joiner
    // test above avoids it: placement's grace tier force-joins under-filled
    // young tournaments, so a fresh client lands in an EXISTING field that has
    // very likely already rated. Boards deal lazily on GET, so playing into a
    // tournament by id is all this needs. A raw insert also leaves ai_field at
    // 0, which keeps the benchmark personas out and the field genuinely one
    // player deep.
    const { db, createCrossing } = await import('../src/db.js');
    const solo = new TestClient(app, 'Solo');
    await solo.login();
    const { id: tid } = createCrossing(
      () =>
        db
          .prepare(`INSERT INTO tournaments (name, seed, difficulty) VALUES (?, ?, 'perfect') RETURNING *`)
          .get('Tournament', 'solo-crossing-seed') as TournamentRow,
    );
    for (let no = 1; no <= 4; no++) await playBoard(solo, tid, no);

    const detail = await solo.get(`/api/tournaments/${tid}`);
    expect(detail.myDone).toBe(4);
    expect(detail.myEloDelta).toBeNull();
    expect(detail.standings.length).toBe(1);
    for (const s of detail.standings) expect(s.eloDelta).toBeNull();
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
