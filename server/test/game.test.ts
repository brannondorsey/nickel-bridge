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

  // PR #49 review, concern 1: ensureAdvanced (the plain GET board route) ran
  // advanceRobots and unconditionally save()d OUTSIDE withBoardLock/refresh —
  // the exact race submitCall/submitPlay were fixed against above, just
  // relocated. The concrete failure mode: a duplicated tab's slow GET starts
  // advanceRobots from a stale snapshot; before it finishes, a faster tab's
  // submitPlay commits the human's actual card (and any robot follow-up);
  // the slow GET then finishes its stale recomputation and saves it
  // unconditionally, reverting the committed card. loadBoard() itself can
  // never observe a genuine "mid-advance" DB row (advanceRobots always runs
  // to the next human stop before any save — see game.ts), so we construct
  // that in-flight snapshot directly: a GameBoard whose `.calls`/`.contract`
  // reflect the just-closed auction but whose `.plays`/`.row.state` are
  // still pre-advance — exactly what an unrefreshed, still-computing
  // ensureAdvanced call would be holding, the moment before Tab B's plays
  // landed.
  it('a stale ensureAdvanced snapshot never reverts a submitPlay committed after it was taken', async () => {
    // hunt-6 board 1: with the human passing throughout, West declares —
    // opening leader (North) and dummy (East, W-E declaring) are both
    // robots, so reaching South's first defensive turn takes two genuine
    // robot card-play decisions past the auction closing.
    const { t, b: warm } = await loadBoardFor('hunt-6', 1);
    while (warm.row.state === 'bidding') await game.submitCall(warm, 0);
    expect(warm.row.state).toBe('playing');
    expect(warm.contract).toMatchObject({ declarer: 3 }); // West — pinned by the seed
    expect(warm.plays).toHaveLength(2); // North's lead + East's dummy card, already advanced

    // The "stale ensureAdvanced" snapshot: same board, but rolled back to
    // right when the auction closed — full final auction recorded, no plays
    // yet, state still 'bidding'.
    const bStale = game.loadBoard(t, userId, 1, true)!;
    bStale.calls = [...warm.calls];
    bStale.contract = null;
    bStale.plays = [];
    bStale.row = { ...bStale.row, state: 'bidding', contract: null };

    // Meanwhile the real tab keeps playing: South's defensive card, plus
    // whatever robots follow before the next human decision (or the board
    // ending) — a genuinely more-advanced, already-committed state.
    const view = game.boardView(t, warm, 1200) as any;
    expect(view.myTurn).toBe(true);
    await game.submitPlay(warm, (view.legalCards as number[])[0]);
    const committed = { calls: [...warm.calls], plays: [...warm.plays], state: warm.row.state };
    expect(committed.plays.length).toBeGreaterThan(2);

    // The stale snapshot's ensureAdvanced "arrives late". With the fix,
    // refresh() picks up the already-committed state before advanceRobots
    // runs, so this can only converge on / extend `committed`, never revert
    // it — before the fix, it would recompute the (identical) opening lead +
    // dummy card from its own stale view and unconditionally save just
    // those 2 plays, discarding South's card and everything after it.
    await game.ensureAdvanced(bStale);

    const fresh = game.loadBoard(t, userId, 1, true)!;
    expect(fresh.calls).toEqual(committed.calls);
    expect(fresh.plays).toEqual(committed.plays);
  });
});

describe("refresh() row identity scoping (server/src/game.ts, PR #49 review concern 2)", () => {
  // stmtSaveBoard's WHERE clause is scoped to id + tournament_id + user_id,
  // not bare id, because SQLite reuses rowids after deletes (`id INTEGER
  // PRIMARY KEY`, no AUTOINCREMENT — see db.ts). refresh()'s stmtBoardById
  // must match that scoping, or a request holding a GameBoard across an
  // await while demo mode's /api/demo/reset wipes + reseeds could silently
  // load an unrelated board (recycled id) into `b`, and the eventual save()
  // would then write with the wrong identity.
  it('rejects cleanly instead of hanging or crashing when the row is deleted mid-race', async () => {
    const t = makeTournament('refresh-identity-deleted');
    const b = game.loadBoard(t, userId, 1, true)!;
    await game.ensureAdvanced(b);
    expect(b.row.state).toBe('bidding'); // human's first bidding turn

    // Simulate a demo-reset-style wipe landing between this request's initial
    // read and its next mutation.
    db.prepare(`DELETE FROM boards WHERE id = ?`).run(b.row.id);

    await expect(game.submitCall(b, 0)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects cleanly instead of silently adopting a different board when the row id is recycled', async () => {
    // Same seed for both tournaments so board 1's deal (dealer + hands) is
    // identical for t1 and t2 — the point of this test is that a bare `id`
    // lookup can sail straight past every OTHER check (state, whose turn,
    // legality) because the recycled row looks just as valid as the real
    // one; only the tournament_id/user_id scope catches it.
    const seed = 'refresh-identity-recycle';
    const t1 = makeTournament(seed);
    const t2 = makeTournament(seed);
    const other = (
      db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester3','Tester3') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    const b = game.loadBoard(t1, userId, 1, true)!;
    await game.ensureAdvanced(b); // advances to human's first bidding turn
    const recycledId = b.row.id;

    // Delete this board, then insert an unrelated one (different tournament
    // AND user) reusing the exact same id — exactly what a demo-mode wipe +
    // reseed can produce, since SQLite is free to reuse a freed rowid.
    // Mirror `b`'s own calls/state so, under the same deal, it passes every
    // ordinary bidding check too — the only thing that can catch this is
    // identity scoping.
    db.prepare(`DELETE FROM boards WHERE id = ?`).run(recycledId);
    db.prepare(`INSERT INTO boards (id, tournament_id, user_id, board_no, state, calls) VALUES (?, ?, ?, 1, ?, ?)`).run(
      recycledId,
      t2.id,
      other,
      b.row.state,
      JSON.stringify(b.calls),
    );

    // `b` still thinks it owns `recycledId` under t1/userId, but that row
    // now belongs to t2/other — refresh() must not adopt it, even though
    // the recycled row would otherwise look like a perfectly valid position
    // for b's own (identical, same-seed) deal.
    await expect(game.submitCall(b, 0)).rejects.toMatchObject({ statusCode: 409 });

    // And critically: the foreign board must be untouched.
    const foreign = db.prepare(`SELECT calls FROM boards WHERE id = ?`).get(recycledId) as { calls: string };
    expect(JSON.parse(foreign.calls)).toEqual(b.calls);
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
