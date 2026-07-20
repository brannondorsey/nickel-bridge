import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { boardScoreNS, legalCards, playState } from '@bridge/core';
import { freshDbEnv } from './helpers.js';

freshDbEnv('game');

const { db } = await import('../src/db.js');
const game = await import('../src/game.js');

const here = dirname(fileURLToPath(import.meta.url));

let userId = 0;
beforeAll(() => {
  userId = (
    db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester','Tester') RETURNING id`).get() as {
      id: number;
    }
  ).id;
});

function makeTournament(seed: string) {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as any;
}

async function loadBoardFor(seed: string, boardNo: number) {
  const t = makeTournament(seed);
  const b = game.loadBoard(t, userId, boardNo, true)!;
  await game.ensureAdvanced(b);
  return { t, b };
}

/** Drive to completion; human strategy mirrors the golden-trace convention. */
async function driveBoard(t: any, b: any, callFor: (view: any) => number = () => 0): Promise<any[]> {
  const views: any[] = [];
  let view = game.boardView(t, b, 1200);
  views.push(view);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, callFor(view));
    else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, (view.legalCards as number[])[0]);
    else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
    view = game.boardView(t, b, 1200);
    views.push(view);
  }
  return views;
}

describe('declarer scenarios (pinned seeds)', () => {
  it('E/W declares: human defends South only, robots never stall', async () => {
    const { t, b } = await loadBoardFor('hunt-0', 1);
    const views = await driveBoard(t, b);
    expect(b.contract!.declarer % 2).toBe(1); // E or W
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === false)).toBe(true);
    // whenever it was our turn, the hand to play was South
    for (const v of playViews.filter((v2) => v2.myTurn)) expect(v.handToPlay).toBe(2);
    expect(b.row.score_ns).toBe(-280); // deterministic outcome for this seed
  });

  it('North declares: board flips and the human plays both N and dummy S', async () => {
    const { t, b } = await loadBoardFor('hunt-1', 2);
    const views = await driveBoard(t, b);
    expect(b.contract!.declarer).toBe(0);
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === true && v.playingSeat === 0)).toBe(true);
    const handsPlayed = new Set(playViews.filter((v) => v.myTurn).map((v) => v.handToPlay));
    expect(handsPlayed).toEqual(new Set([0, 2])); // both declarer hand and dummy
    expect(b.row.score_ns).toBe(170); // deterministic outcome for this seed
  });

  it('South declares: human plays South and dummy North, no flip', async () => {
    const { t, b } = await loadBoardFor('hunt-6', 1);
    let bidOnce = true;
    const views = await driveBoard(t, b, (view) => {
      if (bidOnce && view.legalCalls.includes(7)) {
        bidOnce = false;
        return 7; // 1NT
      }
      return 0;
    });
    expect(b.contract).toMatchObject({ declarer: 2, strain: 4, level: 1 });
    const playViews = views.filter((v) => v.state === 'playing');
    expect(playViews.every((v) => v.flipped === false)).toBe(true);
    const handsPlayed = new Set(playViews.filter((v) => v.myTurn).map((v) => v.handToPlay));
    expect(handsPlayed).toEqual(new Set([0, 2]));
  });

  it('passed-out board completes with zero score and no contract', async () => {
    const { b } = await loadBoardFor('hunt-1', 1);
    // all four players pass; ensureAdvanced already ran the robots
    if (b.row.state !== 'done') await game.submitCall(b, 0);
    expect(b.row.state).toBe('done');
    expect(b.contract).toBeNull();
    expect(b.row.score_ns).toBe(0);
    expect(b.row.tricks_declarer).toBeNull();
  });
});

describe('automatic laydown claims', () => {
  // Known (via the robot-trace fixture) to hit a claim partway through play —
  // see tools/gen_trace_fixture.mjs and the fixture's tail-reordering diff.
  it('short-circuits a determined board in one request instead of one per remaining card', async () => {
    const { t, b } = await loadBoardFor('robot-trace-v1', 2);
    const views = await driveBoard(t, b);
    expect(b.row.state).toBe('done');
    expect(b.claimed).toBe(true);
    expect(views[views.length - 1].claimed).toBe(true);

    // dummyHand must still be sent once the board is 'done', not just while
    // 'playing' — the client's claim fast-forward animation reconstructs
    // dummy's hand shrinking trick-by-trick from this field, and a claim can
    // resolve many tricks (dummy still holding cards) in the same response
    // that flips state to 'done'. An omitted field here (vs. an empty array)
    // would make dummy's whole fan vanish instantly instead of animating.
    expect(views[views.length - 1].dummyHand).toEqual([]);

    // ordinary play resolves at most one trick boundary per request — the
    // human plays at least one card every trick (see playAnim.ts's staging
    // docstring) — so a claim is the only way more than one trick's worth of
    // play can land between two consecutive 'playing'-state responses.
    const lastPlaying = [...views].reverse().find((v) => v.state === 'playing');
    const tricksResolvedAtOnce = 13 - (lastPlaying?.completedTricks ?? 0);
    expect(tricksResolvedAtOnce).toBeGreaterThan(1);

    // the claimed line is a complete, legal deal: every card was legal when
    // played, all 13 tricks are accounted for, and the persisted score
    // matches the persisted trick count
    expect(b.plays).toHaveLength(52);
    let ps = playState(b.deal, b.contract!, []);
    for (let i = 0; i < b.plays.length; i++) {
      const card = b.plays[i];
      expect(legalCards(b.deal, ps), `card ${i}`).toContain(card);
      ps = playState(b.deal, b.contract!, b.plays.slice(0, i + 1));
    }
    expect(ps.isOver).toBe(true);
    expect(ps.declarerTricks + ps.defenderTricks).toBe(13);
    expect(ps.declarerTricks).toBe(b.row.tricks_declarer);
    expect(b.row.score_ns).toBe(boardScoreNS(b.contract!, b.deal.vul, ps.declarerTricks));
  });

  it('does not fire on a board that never becomes fully determined early', async () => {
    const { t, b } = await loadBoardFor('robot-trace-v1', 4);
    await driveBoard(t, b);
    expect(b.row.state).toBe('done');
    expect(b.contract).not.toBeNull();
    expect(b.claimed).toBeUndefined();
  });
});

describe('concurrent submitCall/submitPlay race (server/src/game.ts)', () => {
  // Simulates a double-tap / duplicated tab: two requests each do their own
  // (synchronous, pre-race) loadBoard read of the SAME board, then race their
  // submitCall through advanceRobots's real async work concurrently. Without
  // the per-board lock + refresh in game.ts, both would validate against the
  // same stale snapshot and each independently save() — the second silently
  // clobbering the first's write (a lost update). With it, the loser must
  // queue behind the winner, re-read the winner's committed state, and hit
  // the ordinary "not your turn" rejection instead of overwriting anything.
  it('exactly one concurrent submitCall is accepted; the other gets a clean 409, never a lost update', async () => {
    const t = makeTournament('race-call');
    // Advance to the human's first bidding decision — always reachable
    // without the auction ending first (the human is one of the four seats,
    // so at most 3 robot passes can precede their first turn).
    const seed = game.loadBoard(t, userId, 1, true)!;
    await game.ensureAdvanced(seed);
    expect(seed.row.state).toBe('bidding');

    // Two independent GameBoard snapshots of the identical committed state —
    // exactly what two concurrent HTTP requests would each produce via their
    // own loadBoard() call before either one's submitCall starts racing.
    const b1 = game.loadBoard(t, userId, 1, true)!;
    const b2 = game.loadBoard(t, userId, 1, true)!;
    const callsBefore = b1.calls.length;

    const results = await Promise.allSettled([game.submitCall(b1, 0), game.submitCall(b2, 0)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.statusCode).toBe(409);

    // The winner is whichever of b1/b2 actually got mutated+saved.
    const winner = results[0].status === 'fulfilled' ? b1 : b2;
    const fresh = game.loadBoard(t, userId, 1, true)!;
    // Exactly one new call landed — a lost update would show either 0 (the
    // winner's write silently overwritten by a loser starting from a stale
    // snapshot) or a mismatch between the DB and the winner's in-memory calls.
    expect(fresh.calls.length).toBeGreaterThan(callsBefore);
    expect(fresh.calls).toEqual(winner.calls);
  });

  it('exactly one concurrent submitPlay is accepted; the other gets a clean 409, never a lost update', async () => {
    // Pinned seed/board reused from the "declarer scenarios" suite above:
    // known to reach 'playing' via robot bidding alone even if the human
    // always passes, so it deterministically produces a human play decision.
    const { t, b: warm } = await loadBoardFor('hunt-0', 1);
    while (warm.row.state === 'bidding') await game.submitCall(warm, 0);
    expect(warm.row.state).toBe('playing');
    const view = game.boardView(t, warm, 1200) as any;
    expect(view.myTurn).toBe(true);
    const card = (view.legalCards as number[])[0];
    const playsBefore = warm.plays.length;

    const b1 = game.loadBoard(t, userId, 1, true)!;
    const b2 = game.loadBoard(t, userId, 1, true)!;
    const results = await Promise.allSettled([game.submitPlay(b1, card), game.submitPlay(b2, card)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 409 ("not your turn") is the common case, but if the loser's stale
    // card also happens to be illegal for whatever fresh decision it landed
    // on (e.g. it was already played, or doesn't follow suit for the new
    // hand to play), submitPlay's legality check rejects it with 400
    // instead — still a clean rejection, never a silent second save.
    expect([400, 409]).toContain((rejected[0] as PromiseRejectedResult).reason.statusCode);

    const winner = results[0].status === 'fulfilled' ? b1 : b2;
    const fresh = game.loadBoard(t, userId, 1, true)!;
    expect(fresh.plays.length).toBeGreaterThan(playsBefore);
    expect(fresh.plays).toEqual(winner.plays);
  });
});

describe('board completion side effects', () => {
  it('completing all boards for two users rates them without any close step', async () => {
    const t = makeTournament('elo-side-effect');
    const other = (
      db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester2','Tester2') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    for (const uid of [userId, other]) {
      for (let no = 1; no <= 4; no++) {
        const b = game.loadBoard(t, uid, no, true)!;
        await game.ensureAdvanced(b);
        // second user bids once on board 2 so results differ
        let bidOnce = uid === other;
        await driveBoard(t, b, (view) => {
          if (bidOnce && no === 2) {
            const bid = (view.legalCalls as number[]).find((a) => a >= 3);
            if (bid !== undefined) {
              bidOnce = false;
              return bid;
            }
          }
          return 0;
        });
      }
    }
    const history = db
      .prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE tournament_id = ?`)
      .get(t.id) as { n: number };
    expect(history.n).toBe(2);
  });
});

describe('robot determinism golden trace', () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures/robot-trace.json'), 'utf8'));

  it('replays byte-identically (fairness invariant of duplicate scoring)', async () => {
    for (const expected of fixture.boards) {
      const { t, b } = await loadBoardFor(fixture.seed, expected.boardNo);
      await driveBoard(t, b);
      expect(b.calls, `board ${expected.boardNo} auction`).toEqual(expected.calls);
      expect(b.plays, `board ${expected.boardNo} play`).toEqual(expected.plays);
      expect(b.contract).toEqual(expected.contract);
      expect(b.row.score_ns).toBe(expected.scoreNS);
    }
  }, 30000);

  it('is reproducible within the same process (same seed → same trace)', async () => {
    const first = await loadBoardFor(fixture.seed, 1);
    await driveBoard(first.t, first.b);
    const second = await loadBoardFor(fixture.seed, 1);
    await driveBoard(second.t, second.b);
    expect(second.b.calls).toEqual(first.b.calls);
    expect(second.b.plays).toEqual(first.b.plays);
  });
});
