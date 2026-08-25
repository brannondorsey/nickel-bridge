import { describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp } from './helpers.js';

/**
 * Home's rating tile delta — "how far did my rating move while I was away".
 *
 * The thing being pinned is why this needs a stored baseline at all. Every
 * other Elo surface here is recompute-on-read: elo_history is wiped and
 * replayed in tournament-id order on every board completion, so it holds one
 * reconstruction under TODAY's data and no memory of what a rating used to
 * say. When a late finisher joins a crossing you already played, the points
 * that lands on you arrive as a RESTATEMENT of that old crossing's delta, not
 * as new points — so leaderboardMovement's "rating then = users.elo minus the
 * points banked since the cutoff", exact for a clock window, is identically
 * zero for "since my last crossing". `users.elo_at_last_crossing` is written
 * at the moment it is true instead; see the migration in db.ts.
 */
freshDbEnv('elo-drift');
const app = await makeApp();

const { db } = await import('../src/db.js');
const { eloDrift, ratedTournamentCount, recomputeElo, stampCrossingBaseline } = await import('../src/tournaments.js');

function addUser(name: string): number {
  return (
    db
      .prepare(`INSERT INTO users (google_id, name, handle, handle_key) VALUES (?, ?, ?, ?) RETURNING id`)
      .get(`dev:${name}`, name, name, name.toLowerCase()) as { id: number }
  ).id;
}

function addTournament(name: string): number {
  return (db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, 'seed') RETURNING id`).get(name) as { id: number })
    .id;
}

/** Finish `count` boards of a crossing, then settle it exactly as game.ts does. */
function finishCrossing(tournamentId: number, userId: number, score: number, count = 4): void {
  for (let no = 1; no <= count; no++) {
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns) VALUES (?, ?, ?, 'done', ?)`,
    ).run(tournamentId, userId, no, score);
  }
  // settleCompletedBoard's order: replay first, snapshot second.
  recomputeElo();
  stampCrossingBaseline(userId, tournamentId);
}

const elo = (userId: number) => (db.prepare(`SELECT elo FROM users WHERE id = ?`).get(userId) as { elo: number }).elo;

describe('rating drift since the last crossing', () => {
  const alice = addUser('DriftAlice');
  const bob = addUser('DriftBob');
  const carol = addUser('DriftCarol');
  const t1 = addTournament('T1');

  it('has nothing to measure from before any crossing is finished', () => {
    expect(eloDrift(alice)).toBeNull();
    expect(ratedTournamentCount(alice)).toBe(0);
  });

  // A crossing of one human rates nobody (recomputeElo's `complete.length < 2`),
  // and it anchors anyway. That is not a special case to work around — it is
  // the ordinary shape of this app, where tournaments never close and a field
  // fills up around you after you have left it.
  it('anchors the moment a crossing ends, before it has rated anyone', () => {
    finishCrossing(t1, alice, 400);
    expect(elo(alice)).toBe(1200);
    expect(ratedTournamentCount(alice)).toBe(0);
    expect(eloDrift(alice)).toBe(0);
  });

  it('reports the points a second finisher hands you while you were away', () => {
    finishCrossing(t1, bob, 100);
    // alice never touched a card, and her rating moved — the whole point
    expect(ratedTournamentCount(alice)).toBe(1);
    expect(eloDrift(alice)).toBe(elo(alice) - 1200);
    expect(eloDrift(alice)).toBeGreaterThan(0);
    // bob just anchored on his own finish: his own swing is never drift, and
    // it is already reported on that crossing's own result screen.
    expect(eloDrift(bob)).toBe(0);
  });

  it('reports the restatement when a late finisher joins a crossing you already played', () => {
    const before = elo(alice);
    const driftBefore = eloDrift(alice)!;
    finishCrossing(t1, carol, 1000); // carol beats both, re-ranking the field
    expect(elo(alice)).not.toBe(before);
    // it accumulates against the anchor rather than resetting per event
    expect(eloDrift(alice)).toBe(driftBefore + (elo(alice) - before));
    expect(eloDrift(carol)).toBe(0);
  });

  it('re-anchors on the next crossing, so drift never double-counts your own play', () => {
    const t2 = addTournament('T2');
    finishCrossing(t2, alice, 600);
    expect(eloDrift(alice)).toBe(0);
    // ...and starts reporting again the moment somebody else moves her
    finishCrossing(t2, bob, 500);
    expect(ratedTournamentCount(alice)).toBe(2);
    expect(eloDrift(alice)).not.toBe(0);
  });

  it('leaves the anchor alone for a crossing that is only part-played', () => {
    const t3 = addTournament('T3');
    const drifted = eloDrift(alice);
    finishCrossing(t3, alice, 700, 3); // three boards of four
    expect(eloDrift(alice)).toBe(drifted);
  });
});

describe('/api/me carries the tile', () => {
  it('sends the rating gate and the drift, and a fresh account has neither', async () => {
    const newcomer = new TestClient(app, 'DriftNewcomer');
    await newcomer.login();
    const me = await newcomer.get('/api/me');
    // ELO_INITIAL is a starting value, not an achievement — Home keeps the
    // greeting until ratedTournaments says a crossing actually rated them.
    expect(me.user.elo).toBe(1200);
    expect(me.user.ratedTournaments).toBe(0);
    expect(me.user.eloDrift).toBeNull();
  });
});
