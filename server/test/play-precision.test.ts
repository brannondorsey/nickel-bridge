import { describe, expect, it } from 'vitest';
import { dealBoard } from '@bridge/core';
import { solveFutureTricks } from '@bridge/ai';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('play-precision');
const { db } = await import('../src/db.js');
const app = await makeApp();

const alice = new TestClient(app, 'PrecisionAlice');
await alice.login();

async function userId(client: TestClient): Promise<number> {
  return (await client.get('/api/me')).user.id;
}

function makeTournament(seed: string): { id: number; seed: string } {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as {
    id: number;
    seed: string;
  };
}

function rawBoard(tournamentId: number, uid: number, boardNo: number): any {
  return db
    .prepare(`SELECT * FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`)
    .get(tournamentId, uid, boardNo);
}

describe('capturePlayPrecision (server/src/game.ts)', () => {
  it('captures the declarer-side DD ceiling on an ordinary N-S-declared completion', async () => {
    // 'hunt-1' board 2: North declares, deterministic score_ns=170 (pinned in
    // game.test.ts's "declarer scenarios" suite) — an N-S-declared board, so
    // it's exactly the population playPrecision counts.
    const t = makeTournament('hunt-1');
    const uid = await userId(alice);
    const views = await playBoard(alice, t.id, 2);
    expect(views[views.length - 1].state).toBe('done');

    const row = rawBoard(t.id, uid, 2);
    expect(row.contract).not.toBeNull();
    expect(row.dd_declarer_tricks).not.toBeNull();

    // Independently recompute the ceiling the same way capturePlayPrecision
    // does — 13 minus the OPENING LEADER's (a defender's) raw DD bestScore —
    // and confirm the persisted value matches. This is the concrete guard
    // against the sign flip: playState's opening leader with an empty plays
    // array is nextSeat(contract.declarer), i.e. a defender, so using
    // bestScore directly (instead of 13 - bestScore) would silently persist
    // the DEFENSE's ceiling instead of declarer's.
    const contract = JSON.parse(row.contract);
    const deal = dealBoard(t.seed, 2);
    const solve = await solveFutureTricks(deal, contract, []);
    expect(row.dd_declarer_tricks).toBe(13 - solve.bestScore);

    // At the (default, unset) 'perfect' tier every robot decision is
    // DD-optimal, and this test drives the human's own declarer/dummy play
    // with playBoard's default "first legal card" strategy — deliberately
    // NOT optimal. Facing DD-optimal defense, that can never beat the
    // ceiling, only meet or fall short of it.
    expect(row.tricks_declarer).toBeLessThanOrEqual(row.dd_declarer_tricks);
  });

  it('still captures the ceiling when the board resolves via an automatic laydown claim', async () => {
    // Known (via the robot-trace fixture) to hit a claim partway through
    // play — see tools/gen_trace_fixture.mjs and game.test.ts's "automatic
    // laydown claims" suite. Completion here still routes through
    // submitPlay's not-done -> done transition, same as ordinary play — the
    // capture call is gated on that transition, not on how the board got
    // there, so a claimed tail is no different from ordinary play.
    const t = makeTournament('robot-trace-v1');
    const uid = await userId(alice);
    const views = await playBoard(alice, t.id, 2);
    expect(views[views.length - 1].state).toBe('done');
    expect(views[views.length - 1].claimed).toBe(true);

    const row = rawBoard(t.id, uid, 2);
    expect(row.contract).not.toBeNull();
    expect(row.dd_declarer_tricks).not.toBeNull();
    // Same independent recomputation as the ordinary-play test above: the
    // ceiling is solved from the TOP of the deal (empty plays), not from
    // wherever the claim happened to fire, so it must agree regardless of
    // how much of the claimed tail was fast-played.
    const contract = JSON.parse(row.contract);
    const deal = dealBoard(t.seed, 2);
    const solve = await solveFutureTricks(deal, contract, []);
    expect(row.dd_declarer_tricks).toBe(13 - solve.bestScore);
  });

  it('leaves the ceiling null on a passed-out board', async () => {
    // Pinned seed/board from game.test.ts's "passed-out board completes"
    // test: all four players pass, no contract to solve a ceiling for.
    const t = makeTournament('hunt-1');
    const uid = await userId(alice);
    let view = await alice.get(`/api/tournaments/${t.id}/boards/1`);
    if (view.state !== 'done') {
      view = (await alice.post(`/api/tournaments/${t.id}/boards/1/call`, { call: 0 })).board;
    }
    expect(view.state).toBe('done');
    const row = rawBoard(t.id, uid, 1);
    expect(row.contract).toBeNull();
    expect(row.dd_declarer_tricks).toBeNull();
  });

  it('leaves a legacy (pre-migration) row null and excludes it from the aggregate without crashing', async () => {
    // A fresh client, isolated from alice's boards above: the assertions
    // below need a clean playPrecision.boards === 0, which alice no longer
    // has after the earlier tests in this file captured real ceilings for
    // her.
    const dave = new TestClient(app, 'PrecisionDave');
    await dave.login();
    const uid = await userId(dave);
    // Simulates a board that finished before this stat shipped: a raw insert
    // with a contract and tricks_declarer but no dd_declarer_tricks (the
    // column's default, matching every historical row after the additive
    // migration in db.ts — no backfill).
    const t = makeTournament('legacy-seed');
    const contract = { level: 3, strain: 4, declarer: 0, doubled: false, redoubled: false }; // 3NT, North (N-S)
    db.prepare(
      `INSERT INTO boards (tournament_id, user_id, board_no, state, calls, plays, bid_evals, contract, tricks_declarer, score_ns, updated_at)
       VALUES (?, ?, 1, 'done', '[]', '[]', '[]', ?, 9, 400, unixepoch())`,
    ).run(t.id, uid, JSON.stringify(contract));

    const stats = await dave.get(`/api/users/${uid}/stats`);
    expect(stats.totals.declarer.boards).toBe(1); // counted as a declaring board...
    expect(stats.playPrecision.boards).toBe(0); // ...but not in playPrecision, which needs a captured ceiling
    expect(stats.playPrecision.avgTricksLost).toBeNull();
    expect(stats.playPrecision.precisionPct).toBeNull();
  });
});
