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
const { eloDrift, lastCrossingSwing, ratedTournamentCount, recomputeElo, stampCrossingBaseline } = await import(
  '../src/tournaments.js',
);

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

/**
 * Finish `count` boards of a crossing, then settle it exactly as game.ts does.
 * `at` stamps the boards' updated_at — the bridge elo_history has no timestamp
 * of its own, and what lastCrossingSwing orders by.
 */
function finishCrossing(tournamentId: number, userId: number, score: number, count = 4, at?: number): void {
  for (let no = 1; no <= count; no++) {
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, score_ns, updated_at)
       VALUES (?, ?, ?, 'done', ?, COALESCE(?, unixepoch()))`,
    ).run(tournamentId, userId, no, score, at ?? null);
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

/**
 * The tile's OTHER reading — "▲12 in the last crossing", what your own last
 * crossing was worth. Complementary to drift by construction: whichever is
 * showing, the other is zero or already spent, since stampCrossingBaseline
 * folds a crossing's swing into the drift baseline the moment it ends.
 */
describe('what your last crossing was worth', () => {
  const dave = addUser('SwingDave');
  const erin = addUser('SwingErin');

  it('has nothing to name before a crossing is finished', () => {
    expect(lastCrossingSwing(dave)).toBeNull();
  });

  /**
   * The case this reading exists to get right. A crossing rates nobody until a
   * second human finishes the same field, so one you have just played can sit
   * unrated for days — and the tile must not fill that silence with an earlier
   * crossing's swing under a caption that says "the LAST crossing". Null, so
   * the tile falls back to its label and claims nothing.
   */
  it('stays silent while the crossing you just finished is still unrated', () => {
    const t = addTournament('S1');
    finishCrossing(t, dave, 400, 4, 1_000_000);
    expect(lastCrossingSwing(dave)).toBeNull();
    expect(eloDrift(dave)).toBe(0); // ...and drift has nothing to say either
  });

  it("names the crossing's own swing, stamped with when the player finished it", () => {
    const t = db.prepare(`SELECT id FROM tournaments WHERE name = 'S1'`).get() as { id: number };
    finishCrossing(t.id, erin, 100, 4, 1_000_500);
    const swing = lastCrossingSwing(dave)!;
    // dave beat erin, so his crossing was worth exactly the points it moved him
    expect(swing.delta).toBe(elo(dave) - 1200);
    expect(swing.delta).toBeGreaterThan(0);
    // ...bridged through HIS last board of it, not erin's later one
    expect(swing.finishedAt).toBe(1_000_000);
    // and the same points read as drift, because they arrived after he left —
    // which is the caption Home actually shows here, since dave finished this
    // crossing long before erin turned it into news
    expect(eloDrift(dave)).toBe(swing.delta);
    expect(lastCrossingSwing(erin)!.delta).toBe(elo(erin) - 1200);
    expect(eloDrift(erin)).toBe(0);
  });

  /**
   * The half-step that makes the rule above worth having: a newer unrated
   * crossing HIDES the rated one behind it, rather than letting an older
   * figure keep answering to "the last crossing".
   */
  it('goes back to silence when a newer crossing is finished but unrated', () => {
    const solo = addTournament('S1b');
    expect(lastCrossingSwing(dave)).not.toBeNull(); // the rated S1 above
    finishCrossing(solo, dave, 500, 4, 1_200_000);
    expect(lastCrossingSwing(dave)).toBeNull();
    // ...and it comes back, as that crossing's OWN swing, once someone rates it
    finishCrossing(solo, erin, 50, 4, 1_200_500);
    expect(lastCrossingSwing(dave)!.finishedAt).toBe(1_200_000);
  });

  it('ignores a crossing that is only part-played', () => {
    const part = addTournament('S1c');
    finishCrossing(part, dave, 700, 3, 1_300_000); // three boards of four
    expect(lastCrossingSwing(dave)!.finishedAt).toBe(1_200_000);
  });

  /**
   * Replay order is not play order: elo_history replays in tournament-id
   * order, but a months-old crossing resumed and finished this morning is the
   * one the tile is asking about. Ordered by id, this test's later-numbered
   * tournament would win purely on its number.
   */
  it('takes the most recently FINISHED crossing, not the highest tournament id', () => {
    const older = addTournament('S0-older');
    finishCrossing(older, dave, 900, 4, 2_000_000); // lower id here, finished LAST
    finishCrossing(older, erin, 200, 4, 2_000_100);
    const stale = addTournament('S2-newer');
    finishCrossing(stale, dave, 300, 4, 1_500_000); // higher id, finished EARLIER
    finishCrossing(stale, erin, 800, 4, 1_500_100);
    expect(lastCrossingSwing(dave)!.finishedAt).toBe(2_000_000);
  });
});

describe('/api/me carries the tile', () => {
  it('sends the rating gate, the drift and the last crossing; a fresh account has none', async () => {
    const newcomer = new TestClient(app, 'DriftNewcomer');
    await newcomer.login();
    const me = await newcomer.get('/api/me');
    // ELO_INITIAL is a starting value, not an achievement — Home keeps the
    // greeting until ratedTournaments says a crossing actually rated them.
    expect(me.user.elo).toBe(1200);
    expect(me.user.ratedTournaments).toBe(0);
    expect(me.user.eloDrift).toBeNull();
    expect(me.user.lastCrossing).toBeNull();
  });
});
