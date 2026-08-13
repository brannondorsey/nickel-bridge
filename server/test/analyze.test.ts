import { beforeAll, describe, expect, it, vi } from 'vitest';
import { legalCards, playState } from '@bridge/core';
import { pickFromSolve, solveFutureTricks } from '@bridge/ai';
import { TestClient, freshDbEnv, makeApp } from './helpers.js';

// Stage 3's exclusion of an excused candidate (the sampled engine, from the
// player's own seat, would ALSO have played the card — see analyze.ts's
// stage-3 doc comment) is otherwise hard to hit deterministically: it
// depends on ANALYZE_K=8 real sampled-DD solves agreeing with the actual
// play, which no known seed reliably produces. Gated on a seed prefix
// unique to that one test below, so every other test still exercises the
// genuine scoreCardsSampled implementation untouched.
vi.mock('@bridge/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bridge/ai')>();
  return {
    ...actual,
    scoreCardsSampled: vi.fn(async (deal, contract, plays, opts) => {
      if (opts.seed?.startsWith('analyze-excuse:')) {
        // scoreCardsSampled isn't told which card gets played at this
        // decision (analyze.ts learns that separately) — so every legal
        // card is scored equally, which guarantees whatever card was
        // actually played ties for best, i.e. deficit 0, excused
        const legal = legalCards(deal, playState(deal, contract, plays));
        return { legal, totals: new Map(legal.map((c: number) => [c, 1])), rng: () => 0 };
      }
      return actual.scoreCardsSampled(deal, contract, plays, opts);
    }),
  };
});

freshDbEnv('analyze');

const { db } = await import('../src/db.js');
const game = await import('../src/game.js');
const analyze = await import('../src/analyze.js');

/**
 * The Analyze verdict pipeline's required matrix (spec §11 phase 2): a flat
 * DD trace must produce zero moments, a known blunder exactly one, a claimed
 * board none inside the tail, and a one-player field grades with no costs —
 * plus both flip orientations, the defence boundary (robot North never
 * graded), and the cache's determinism/version/backfill behaviour.
 *
 * Boards are driven through the real engine module (submitCall/submitPlay)
 * on raw-inserted tournaments, which default to the 'perfect' tier — robots
 * are DD-optimal, so a DD-optimal human line yields a provably flat trace.
 */

let userId = 0;
let rivalId = 0;
beforeAll(() => {
  userId = (
    db.prepare(`INSERT INTO users (google_id, name, handle) VALUES ('module:wren','Wren','wren') RETURNING id`).get() as {
      id: number;
    }
  ).id;
  rivalId = (
    db.prepare(`INSERT INTO users (google_id, name, handle) VALUES ('module:margaret','Margaret','margaret') RETURNING id`).get() as {
      id: number;
    }
  ).id;
});

function makeTournament(seed: string) {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as any;
}

type CardChooser = (b: any, view: any) => Promise<number>;

const optimalCard: CardChooser = async (b, view) => {
  const solve = await solveFutureTricks(b.deal, b.contract, b.plays);
  return pickFromSolve(view.legalCards as number[], solve);
};

const firstLegalCard: CardChooser = async (_b, view) => (view.legalCards as number[])[0];

/** drive one user's board to completion through the real engine */
async function driveBoard(
  t: any,
  uid: number,
  boardNo: number,
  card: CardChooser,
  call: (view: any) => number = () => 0,
): Promise<any> {
  const b = game.loadBoard(t, uid, boardNo, true)!;
  await game.ensureAdvanced(b);
  let view = game.boardView(t, b, 1200);
  let safety = 250;
  while (view.state !== 'done' && safety-- > 0) {
    if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, call(view));
    else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, await card(b, view));
    else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
    view = game.boardView(t, b, 1200);
  }
  if (view.state !== 'done') throw new Error('board did not finish');
  return b;
}

/**
 * Drives an optimal rival then a deliberate blunderer on the same board: the
 * rival plays the DD-optimal line the blunderer would have played, so the
 * counterfactual ties them (50%) while the actual loses outright (0%) — a
 * clean 50-point cost, comfortably over MOMENT_FLOOR. Shared by every test
 * below that needs one guaranteed, deterministic moment to work with.
 */
async function driveOneBlunder(t: any, uid: number, rival: number, boardNo: number): Promise<{ b: any; blunderPly: number }> {
  await driveBoard(t, rival, boardNo, optimalCard);
  let blunderPly = -1;
  const b = await driveBoard(t, uid, boardNo, async (bb, view) => {
    const legal = view.legalCards as number[];
    const solve = await solveFutureTricks(bb.deal, bb.contract, bb.plays);
    if (blunderPly < 0) {
      const worst = [...legal].sort((a, c) => (solve.cardScores.get(a) ?? 99) - (solve.cardScores.get(c) ?? 99))[0];
      if ((solve.cardScores.get(worst) ?? 0) < solve.bestScore) {
        blunderPly = bb.plays.length;
        return worst;
      }
    }
    return pickFromSolve(legal, solve);
  });
  return { b, blunderPly };
}

describe('gradeFromDeficit', () => {
  it('bands a positive deficit — deficit <= 0 is the excused case, filtered before this ever runs', () => {
    expect(analyze.gradeFromDeficit(2)).toBe(0);
    expect(analyze.gradeFromDeficit(1.5)).toBe(0);
    expect(analyze.gradeFromDeficit(1)).toBe(1);
    expect(analyze.gradeFromDeficit(0.5)).toBe(1);
    expect(analyze.gradeFromDeficit(0.4)).toBe(2);
  });
});

describe('the verdict matrix', () => {
  it('flat trace (DD-optimal human) ⇒ zero plies, zero moments — the canary', async () => {
    const t = makeTournament('analyze-a'); // probed: 6♦ by West, 8 human decisions, no pass-out
    const b = await driveBoard(t, userId, 1, optimalCard);
    await driveBoard(t, rivalId, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');
    const view = await analyze.getBoardAnalysis(t, b, false);
    expect(view.singleField).toBe(false);
    expect(view.plies).toEqual([]);
    expect(view.moments).toEqual([]);
    expect(view.setAside).toBe(0);
    expect(view.ddTricks![0]).toBe(view.ddTricks![view.ddTricks!.length - 1]);
  }, 240_000);

  it('one deliberate blunder against an optimal rival ⇒ exactly one moment at that ply', async () => {
    const t = makeTournament('analyze-f'); // probed: 2♠ by West, first strictly-worse card exists at ply 2
    // the rival plays the identical DD-optimal line the blunderer WOULD have
    // played, so the counterfactual ties them (50%) while the actual loses
    // outright (0%) — a clean 50-point cost, comfortably over MOMENT_FLOOR
    await driveBoard(t, rivalId, 1, optimalCard);
    let blunderPly = -1;
    const b = await driveBoard(t, userId, 1, async (bb, view) => {
      const legal = view.legalCards as number[];
      const solve = await solveFutureTricks(bb.deal, bb.contract, bb.plays);
      if (blunderPly < 0) {
        const worst = [...legal].sort(
          (a, c) => (solve.cardScores.get(a) ?? 99) - (solve.cardScores.get(c) ?? 99),
        )[0];
        if ((solve.cardScores.get(worst) ?? 0) < solve.bestScore) {
          blunderPly = bb.plays.length;
          return worst;
        }
      }
      return pickFromSolve(legal, solve);
    });
    expect(blunderPly).toBeGreaterThanOrEqual(0);
    const view = await analyze.getBoardAnalysis(t, b, false);
    expect(view.plies).toHaveLength(1);
    expect(view.plies[0].ply).toBe(blunderPly);
    expect(view.plies[0].mpCost).toBe(50);
    expect(view.plies[0].sampled).not.toBeNull();
    expect(view.moments).toHaveLength(1);
    expect(view.moments[0]).toMatchObject({ kind: 'play', ply: blunderPly, mpCost: 50 });
  }, 240_000);

  it('claimed board ⇒ nothing graded inside the tail, and the boundary re-derives identically', async () => {
    const t = makeTournament('robot-trace-v1'); // board 2 claims (see game.test.ts)
    const b = await driveBoard(t, userId, 2, firstLegalCard);
    expect(b.row.claimed_at_ply).not.toBeNull();
    const view = await analyze.getBoardAnalysis(t, b, false);
    expect(view.claimedAtPly).toBe(b.row.claimed_at_ply);
    for (const p of view.plies) expect(p.ply).toBeLessThan(view.claimedAtPly!);

    // legacy path: NULL the column and drop the cache — the claim-gate walk
    // must re-derive the exact same boundary (DDS is deterministic)
    db.prepare(`UPDATE boards SET claimed_at_ply = NULL WHERE id = ?`).run(b.row.id);
    db.prepare(`DELETE FROM board_analyses WHERE board_id = ?`).run(b.row.id);
    const b2 = game.loadBoard(t, userId, 2, false)!;
    expect(b2.row.claimed_at_ply).toBeNull();
    const view2 = await analyze.getBoardAnalysis(t, b2, false);
    expect(view2.claimedAtPly).toBe(view.claimedAtPly);
    expect(view2.plies).toEqual(view.plies);
  }, 240_000);

  it('one-player field ⇒ grades with no costs and no moments', async () => {
    const t = makeTournament('analyze-lonely');
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');
    const view = await analyze.getBoardAnalysis(t, b, false);
    expect(view.singleField).toBe(true);
    expect(view.actualPct).toBeNull();
    expect(view.moments).toEqual([]);
    expect(view.plies.length).toBeGreaterThan(0); // first-legal play blunders
    for (const p of view.plies) {
      expect(p.mpCost).toBeNull();
      expect(p.cfPct).toBeNull();
    }
    // stage 3 still ran, gated on the DD trick loss instead of a cost
    expect(view.plies.some((p: any) => p.sampled !== null)).toBe(true);
  }, 240_000);

  it('excused: a DD-costly ply the sampled engine would also have played is dropped entirely, not flagged', async () => {
    // scoreCardsSampled is mocked (top of file, gated on this exact seed) to
    // always report the played card as its own top pick — the "only double
    // dummy sees better" case. Every candidate that reaches stage 3 must
    // therefore vanish from the response: no ply, no moment, nothing to
    // argue the player's innocence over.
    const t = makeTournament('analyze-excuse');
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');
    const view = await analyze.getBoardAnalysis(t, b, false);
    expect(view.plies).toEqual([]);
    expect(view.moments).toEqual([]);
  }, 240_000);

  it('defending: only South is ever graded — robot partner North never', async () => {
    const t = makeTournament('hunt-0'); // board 1: E/W declares (see game.test.ts)
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    expect(b.contract!.declarer % 2).toBe(1);
    const view = await analyze.getBoardAnalysis(t, b, false);
    for (const p of view.plies) expect(p.seat).toBe(2);
  }, 240_000);

  it('North declares (flipped): the human is graded on both North and dummy South', async () => {
    const t = makeTournament('hunt-1'); // board 2: North declares (see game.test.ts)
    const b = await driveBoard(t, userId, 2, firstLegalCard);
    expect(b.contract!.declarer).toBe(0);
    const view = await analyze.getBoardAnalysis(t, b, false);
    for (const p of view.plies) expect([0, 2]).toContain(p.seat);
  }, 240_000);
});

describe('cache behaviour', () => {
  it('two computes are byte-identical; par backfills without touching core; version bump recomputes', async () => {
    const t = makeTournament('analyze-cache');
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');

    const first = await analyze.getBoardAnalysis(t, b, false);
    const rowAfterFirst = db.prepare(`SELECT version, core, par FROM board_analyses WHERE board_id = ?`).get(b.row.id) as any;
    expect(rowAfterFirst.version).toBe(analyze.ANALYZE_VERSION);
    expect(rowAfterFirst.par).toBeNull();

    const second = await analyze.getBoardAnalysis(t, b, false);
    expect(second).toEqual(first);

    // par backfill: core column must be BYTE-identical afterwards
    const withPar = await analyze.getBoardAnalysis(t, b, true);
    expect(withPar.par).not.toBeNull();
    expect(typeof withPar.par!.parScore).toBe('number');
    expect(withPar.par!.parContracts.length).toBeGreaterThan(0);
    const rowAfterPar = db.prepare(`SELECT core, par FROM board_analyses WHERE board_id = ?`).get(b.row.id) as any;
    expect(rowAfterPar.core).toBe(rowAfterFirst.core);
    expect(rowAfterPar.par).not.toBeNull();

    // every human call answered in the auction analysis, in call order
    const humanCalls = b.calls.filter((_: number, i: number) => (b.deal.dealer + i) % 4 === 2);
    expect(withPar.par!.calls.map((c: any) => c.call)).toEqual(humanCalls);

    // stale version ⇒ recompute (deterministic, so the same answer)
    db.prepare(`UPDATE board_analyses SET version = 0 WHERE board_id = ?`).run(b.row.id);
    const recomputed = await analyze.getBoardAnalysis(t, b, true);
    expect(recomputed.plies).toEqual(withPar.plies);
    expect(
      (db.prepare(`SELECT version FROM board_analyses WHERE board_id = ?`).get(b.row.id) as any).version,
    ).toBe(analyze.ANALYZE_VERSION);
  }, 240_000);

  it('a cached analysis never blocks its board being deleted (demo wipe/replay paths)', async () => {
    // demo.ts's per-exhibit wipe and demo-seed's full reset both DELETE FROM
    // boards with foreign_keys ON — without ON DELETE CASCADE on
    // board_analyses, analyzing an exhibit board once made re-running that
    // exhibit throw FOREIGN KEY constraint failed (the review finding this
    // test pins).
    const t = makeTournament('analyze-cascade');
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    await analyze.getBoardAnalysis(t, b, false);
    expect(db.prepare(`SELECT 1 FROM board_analyses WHERE board_id = ?`).get(b.row.id)).toBeTruthy();
    expect(() => db.prepare(`DELETE FROM boards WHERE id = ?`).run(b.row.id)).not.toThrow();
    expect(db.prepare(`SELECT 1 FROM board_analyses WHERE board_id = ?`).get(b.row.id)).toBeUndefined();
  }, 240_000);

  it('the matchpoint layer is served against the LIVE field, one field for play and par alike', async () => {
    const t = makeTournament('analyze-freeze');
    const b = await driveBoard(t, userId, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');
    const solo = await analyze.getBoardAnalysis(t, b, false); // caches core against a field of one
    expect(solo.singleField).toBe(true);
    expect(solo.momentFloor).toBe(analyze.MOMENT_FLOOR);
    // the field grows AFTER core is cached...
    await driveBoard(t, rivalId, 1, firstLegalCard);
    // ...and the next serve re-measures everything against today's field:
    // the engine facts come from the cache, the matchpoint figures do not —
    // so the refusal lifts, play costs and bid gains share the two-table
    // field, and nothing mixes field sizes within one response
    const withPar = await analyze.getBoardAnalysis(t, b, true);
    expect(withPar.singleField).toBe(false);
    expect(withPar.fieldScores).toHaveLength(2);
    expect(withPar.actualPct).not.toBeNull();
    for (const p of withPar.plies) {
      expect(p.mpCost).not.toBeNull();
      expect(p.cfPct).not.toBeNull();
    }
    for (const c of withPar.par!.calls) {
      if (c.cf) expect(c.cf.mpGain).toBeCloseTo(c.cf.cfPct! - withPar.actualPct!, 6);
    }
    // the engine facts themselves are untouched by the refresh
    expect(withPar.plies.map((p) => ({ ply: p.ply, card: p.card, ddLoss: p.ddLoss, sampled: p.sampled }))).toEqual(
      solo.plies.map((p) => ({ ply: p.ply, card: p.card, ddLoss: p.ddLoss, sampled: p.sampled })),
    );
  }, 240_000);

  it('a ply that never cleared the floor at first open gets its stage-3 verdict once the field drifts it over — and the backfill is persisted', async () => {
    const t = makeTournament('analyze-f');
    const { b, blunderPly } = await driveOneBlunder(t, userId, rivalId, 1);
    const original = await analyze.getBoardAnalysis(t, b, false);
    expect(original.plies).toHaveLength(1);
    expect(original.plies[0].mpCost).toBe(50); // comfortably over MOMENT_FLOOR
    expect(original.plies[0].sampled).not.toBeNull();
    expect(original.moments).toHaveLength(1);

    // Simulate first-open having happened against a floor this ply didn't
    // clear (a thinner field, or a higher MOMENT_FLOOR at the time) by
    // hand-resetting the cached verdict to unjudged — the same
    // hand-editing-cached-state technique the claim-boundary legacy test
    // above uses. mpCost is NOT touched: refreshMatchpointLayer recomputes
    // it fresh from the live field on every serve regardless, so leaving it
    // stale here would be overwritten immediately and prove nothing.
    const row = db.prepare(`SELECT core FROM board_analyses WHERE board_id = ?`).get(b.row.id) as { core: string };
    const core = JSON.parse(row.core);
    core.plies[0].sampled = null;
    db.prepare(`UPDATE board_analyses SET core = ? WHERE board_id = ?`).run(JSON.stringify(core), b.row.id);
    const rowAfterReset = db.prepare(`SELECT core FROM board_analyses WHERE board_id = ?`).get(b.row.id) as {
      core: string;
    };
    expect(JSON.parse(rowAfterReset.core).plies[0].sampled).toBeNull(); // confirms the mutation actually landed

    // The very next serve IS the "field drifted over the floor" case:
    // refreshMatchpointLayer recomputes mpCost fresh from the (unchanged,
    // real) field first — still 50, still over MOMENT_FLOOR — and
    // backfillDriftedPlies then gives the ply the stage-3 solve it never
    // got, byte-identical to the original verdict (same seed, same deal,
    // same played card) since sampleFindability is deterministic regardless
    // of when it runs. There is no separately-observable "unjudged" response
    // in between: the backfill runs inside this very call.
    const backfilled = await analyze.getBoardAnalysis(t, b, false);
    expect(backfilled.plies[0].sampled).toEqual(original.plies[0].sampled);
    expect(backfilled.moments).toHaveLength(1);
    expect(backfilled.moments[0]).toMatchObject({ kind: 'play', ply: blunderPly, mpCost: 50 });

    // and it was PERSISTED, not just recomputed for this one response — a
    // third serve with no further mutation must not need to re-solve
    const rowAfterBackfill = db.prepare(`SELECT core FROM board_analyses WHERE board_id = ?`).get(b.row.id) as {
      core: string;
    };
    const persisted = JSON.parse(rowAfterBackfill.core);
    expect(persisted.plies[0].sampled).toEqual(original.plies[0].sampled);
    // and the write that persisted it did NOT bake in the live field's
    // mpCost — see the next test for why that matters generally
    expect(persisted.plies[0].cfPct).toBeNull();
    expect(persisted.plies[0].mpCost).toBeNull();
  }, 240_000);

  it('the persisted cache never bakes in a live-field snapshot — cfPct/mpCost are null on disk at every write site, always recomputed on serve', async () => {
    const t = makeTournament('analyze-f');
    const { b } = await driveOneBlunder(t, userId, rivalId, 1);

    // write site 1: computeCore's own first-open write
    const view = await analyze.getBoardAnalysis(t, b, true); // wantPar=true also exercises write site 2 below
    expect(view.plies[0].mpCost).toBe(50); // the SERVED response still carries the real, live value
    const row1 = db.prepare(`SELECT core, par FROM board_analyses WHERE board_id = ?`).get(b.row.id) as {
      core: string;
      par: string;
    };
    const core1 = JSON.parse(row1.core);
    expect(core1.plies[0].cfPct).toBeNull();
    expect(core1.plies[0].mpCost).toBeNull();
    const par1 = JSON.parse(row1.par);
    for (const c of par1.calls) if (c.cf) { expect(c.cf.cfPct).toBeNull(); expect(c.cf.mpGain).toBeNull(); }

    // write site 2 in isolation: par backfilled onto an EXISTING cached core
    // (a board first opened without ?par=1, then reopened with it)
    const t2 = makeTournament('analyze-f');
    const { b: b2 } = await driveOneBlunder(t2, userId, rivalId, 1);
    await analyze.getBoardAnalysis(t2, b2, false); // caches core, no par yet
    const rowNoParYet = db.prepare(`SELECT par FROM board_analyses WHERE board_id = ?`).get(b2.row.id) as {
      par: string | null;
    };
    expect(rowNoParYet.par).toBeNull();
    await analyze.getBoardAnalysis(t2, b2, true); // backfills par via stmtPutPar
    const row2 = db.prepare(`SELECT par FROM board_analyses WHERE board_id = ?`).get(b2.row.id) as { par: string };
    const par2 = JSON.parse(row2.par);
    for (const c of par2.calls) if (c.cf) { expect(c.cf.cfPct).toBeNull(); expect(c.cf.mpGain).toBeNull(); }
  }, 240_000);
});

describe('the endpoint', () => {
  it('refuses anonymously, 404s a live or missing board, serves a finished one', async () => {
    const app = await makeApp();
    const client = new TestClient(app, 'endpoint');
    await client.login();
    const me = await client.get('/api/me');
    const t = makeTournament('analyze-endpoint');
    const uid = me.user.id;
    const b = await driveBoard(t, uid, 1, firstLegalCard);
    if (!b.contract) throw new Error('seed produced a pass-out; pick another');

    // anonymous ⇒ 401
    const anon = new TestClient(app, 'nobody');
    const res401 = await anon.raw('GET', `/api/tournaments/${t.id}/boards/1/analysis`);
    expect(res401.statusCode).toBe(401);

    // a board still in progress ⇒ 404 (not analyzable), as is a bad board no
    await client.get(`/api/tournaments/${t.id}/boards/2`); // starts board 2 (bidding)
    const live = await client.raw('GET', `/api/tournaments/${t.id}/boards/2/analysis`);
    expect(live.statusCode).toBe(404);
    const bogus = await client.raw('GET', `/api/tournaments/${t.id}/boards/9/analysis`);
    expect(bogus.statusCode).toBe(404);

    // finished ⇒ the analysis, without par by default, with it on ?par=1
    const plain = await client.get(`/api/tournaments/${t.id}/boards/1/analysis`);
    expect(plain.version).toBe(analyze.ANALYZE_VERSION);
    expect(plain.par).toBeNull();
    expect(Array.isArray(plain.moments)).toBe(true);
    const withPar = await client.get(`/api/tournaments/${t.id}/boards/1/analysis?par=1`);
    expect(withPar.par).not.toBeNull();

    // Analyze is still in beta (see the beta_features migration in db.ts) —
    // an account that has opted back out is refused even though it is
    // signed in and the board is genuinely analyzable, since the client's
    // ANALYZE PLAY door is only a courtesy and this route is the real gate.
    await client.post('/api/me/prefs', { betaFeatures: false });
    const gated = await client.raw('GET', `/api/tournaments/${t.id}/boards/1/analysis`);
    expect(gated.statusCode).toBe(403);

    await app.close();
  }, 240_000);
});
