import { matchpoints } from '@bridge/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('rehearsal');
const app = await makeApp();
const { db } = await import('../src/db.js');
const { boardFieldRows } = await import('../src/game.js');

const alice = new TestClient(app, 'Alice');
const bob = new TestClient(app, 'Bob');

beforeAll(async () => {
  await alice.login();
  await bob.login();
});

function boardRow(tournamentId: number, boardNo?: number): any {
  return boardNo
    ? db.prepare(`SELECT * FROM boards WHERE tournament_id = ? AND board_no = ?`).get(tournamentId, boardNo)
    : db.prepare(`SELECT * FROM boards WHERE tournament_id = ?`).get(tournamentId);
}

function tournamentRow(id: number): any {
  return db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id);
}

const eloHistory = () => db.prepare(`SELECT user_id, tournament_id, before, after FROM elo_history ORDER BY id`).all();

/**
 * Place `client` into a board and finish it through the real API — retried
 * until it reaches a contract with at least one rehearsable ply, since two
 * things can leave nothing to branch from: `playBoard`'s default always-pass
 * call strategy can genuinely pass a hand out (no contract), and — rarer,
 * but real, since claim detection is true-DD at every tier — the very first
 * decision can already be a 100% laydown (`claimed_at_ply === 0`), meaning
 * every card was server-played and there is no ply before the boundary.
 */
async function finishedBoard(client: TestClient): Promise<{ tournamentId: number; boardNo: number }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { tournamentId, boardNo } = await client.post('/api/play');
    await playBoard(client, tournamentId, boardNo);
    const row = boardRow(tournamentId, boardNo);
    if (row.contract && row.claimed_at_ply !== 0) return { tournamentId, boardNo };
  }
  throw new Error('could not find a rehearsable (contracted, not claimed-at-ply-0) board after several attempts');
}

/**
 * A branch ply guaranteed valid for `origin` — genuine gameplay (the
 * always-first-legal-card default strategy) claims well before the end far
 * more often than not, since claim detection is true-DD at every tier, so
 * blindly branching near the end of `plays` routinely lands past the
 * boundary. Picks a point well inside whatever IS playable — before the
 * claim boundary if one exists, otherwise before the end.
 */
function safeBranchPly(origin: any): number {
  const plays = JSON.parse(origin.plays);
  const cap = origin.claimed_at_ply ?? plays.length;
  return Math.max(0, Math.floor(cap / 2));
}

describe('POST .../rehearse — seeding correctness', () => {
  it('copies the auction verbatim and truncates plays at the branch ply, on the origin seed/board_no', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const originCalls = JSON.parse(origin.calls);
    const originPlays = JSON.parse(origin.plays);
    const originBidEvals = JSON.parse(origin.bid_evals);
    const branchPly = safeBranchPly(origin);

    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    expect(created.boardNo).toBe(boardNo);
    expect(created.tournamentId).not.toBe(tournamentId);

    const rehT = tournamentRow(created.tournamentId);
    expect(rehT.kind).toBe('rehearsal');
    expect(rehT.seed).toBe(tournamentRow(tournamentId).seed);
    expect(rehT.origin_tournament_id).toBe(tournamentId);
    expect(rehT.origin_board_no).toBe(boardNo);
    expect(rehT.branch_ply).toBe(branchPly);
    expect(rehT.ai_field).toBe(0);

    const rehBoard = boardRow(created.tournamentId);
    const rehPlays = JSON.parse(rehBoard.plays);
    expect(rehBoard.board_no).toBe(boardNo);
    expect(JSON.parse(rehBoard.calls)).toEqual(originCalls);
    expect(JSON.parse(rehBoard.bid_evals)).toEqual(originBidEvals);
    expect(JSON.parse(rehBoard.contract)).toEqual(JSON.parse(origin.contract));
    // Only the PREFIX is guaranteed to match the origin verbatim — createRehearsal
    // then runs ensureAdvanced once, which may append further robot-played
    // cards immediately after the branch point (the same "fast-forward to the
    // human's turn" any fresh board load already does).
    expect(rehPlays.slice(0, branchPly)).toEqual(originPlays.slice(0, branchPly));
    expect(rehPlays.length).toBeGreaterThanOrEqual(branchPly);
    expect(rehBoard.claimed_at_ply).toBeNull();
  });

  it('carries rehearsal metadata on boardView and redacts hidden hands exactly like a live board', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);

    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const view = await alice.get(`/api/tournaments/${created.tournamentId}/boards/${created.boardNo}`);

    expect(view.rehearsal).toEqual({ originTournamentId: tournamentId, originBoardNo: boardNo, branchPly });
    if (view.state === 'done') {
      // ensureAdvanced fast-forwarded straight to completion (every
      // remaining decision belonged to a robot) — allHands is legitimately
      // sent for a done board, same as any live board.
      expect(view.allHands).toBeDefined();
    } else {
      // The core "opponents hidden" invariant — the same redaction boardView
      // already applies to every board, unmodified; this just confirms a
      // rehearsal board (a raw-seeded row) doesn't slip past it.
      expect(view.allHands).toBeUndefined();
      expect(view.playHistory).toBeUndefined();
    }
  });

  it('404s when the origin board has not finished', async () => {
    const { tournamentId, boardNo } = await bob.post('/api/play');
    const res = await bob.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: 0 });
    expect(res.statusCode).toBe(404);
  });

  it('400s on an out-of-range branch ply', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const originPlays = JSON.parse(boardRow(tournamentId, boardNo).plays);

    const negative = await alice.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: -1 });
    expect(negative.statusCode).toBe(400);

    const pastEnd = await alice.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: originPlays.length,
    });
    expect(pastEnd.statusCode).toBe(400);
  });

  it('400s branching at or past the claim boundary', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const originPlays = JSON.parse(origin.plays);
    // Force a claim boundary partway through, deterministically — genuine
    // gameplay claims at a seed-dependent point, so the boundary is stamped
    // directly rather than relying on one arising naturally in this hand.
    const boundary = Math.max(1, originPlays.length - 2);
    db.prepare(`UPDATE boards SET claimed_at_ply = ? WHERE id = ?`).run(boundary, origin.id);

    const atBoundary = await alice.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: boundary });
    expect(atBoundary.statusCode).toBe(400);
    const pastBoundary = await alice.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: boundary + 1,
    });
    expect(pastBoundary.statusCode).toBe(400);
    const beforeBoundary = await alice.raw('POST', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: boundary - 1,
    });
    expect(beforeBoundary.statusCode).toBe(200);
  });
});

describe('never scored', () => {
  it('does not appear in the lobby list', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });
    const { tournaments } = await alice.get('/api/tournaments');
    expect(tournaments.some((t: { id: number }) => t.id === created.tournamentId)).toBe(false);
  });

  it('finishing a rehearsal never moves elo_history', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });
    const before = eloHistory();
    await playBoard(alice, created.tournamentId, created.boardNo);
    expect(eloHistory()).toEqual(before);
  });
});

describe('one level deep', () => {
  it('404s GET .../analysis for a rehearsal tournament', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });
    await playBoard(alice, created.tournamentId, created.boardNo);
    const res = await alice.raw('GET', `/api/tournaments/${created.tournamentId}/boards/${created.boardNo}/analysis`);
    expect(res.statusCode).toBe(404);
  });

  it('400s a rehearsal-of-a-rehearsal, even called directly against the API', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });
    // Finish the rehearsal so it has a genuine 'done' board of its own to
    // (attempt to) branch from — the UI never offers this door, but the
    // route takes an arbitrary tournament id, so it must refuse this itself
    // rather than relying on the client only ever passing top-level ids.
    await playBoard(alice, created.tournamentId, created.boardNo);
    const res = await alice.raw('POST', `/api/tournaments/${created.tournamentId}/boards/${created.boardNo}/rehearse`, {
      ply: 0,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('reload survival', () => {
  it('GET returns the same position mid-play and again after finishing, no special session state', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });

    const midA = await alice.get(`/api/tournaments/${created.tournamentId}/boards/${created.boardNo}`);
    const midB = await alice.get(`/api/tournaments/${created.tournamentId}/boards/${created.boardNo}`);
    expect(midB).toEqual(midA);

    if (midA.state !== 'done') await playBoard(alice, created.tournamentId, created.boardNo);

    const doneA = await alice.get(`/api/tournaments/${created.tournamentId}/boards/${created.boardNo}`);
    const doneB = await alice.get(`/api/tournaments/${created.tournamentId}/boards/${created.boardNo}`);
    expect(doneA.state).toBe('done');
    expect(doneB).toEqual(doneA);
    expect(doneA.originResult).toBeDefined();
    const originView = await alice.get(`/api/tournaments/${tournamentId}/boards/${boardNo}`);
    expect(doneA.originResult.contractLabel).toBe(originView.result.contractLabel);
    expect(doneA.originResult.scoreNS).toBe(originView.result.scoreNS);
  });
});

describe('matchpoint comparison (old vs new)', () => {
  // Driven through the real engine module directly (game.js/rehearsal.js on
  // raw-inserted tournaments), the same style analyze.test.ts uses for its
  // own "one-player field" case — going through HTTP placement instead would
  // be at the mercy of the grace window force-joining whatever tournaments
  // this file's earlier tests already left lying around, so field size
  // couldn't be controlled from here.
  it("is null against a one-player origin field, and matches a direct substitution against the origin's real multi-player field", async () => {
    const gameMod = await import('../src/game.js');
    const rehearsalMod = await import('../src/rehearsal.js');

    function makeUser(handle: string): number {
      return (
        db
          .prepare(`INSERT INTO users (google_id, name, handle) VALUES (?, ?, ?) RETURNING id`)
          .get(`module:${handle}`, handle, handle) as { id: number }
      ).id;
    }
    function makeTournament(seed: string): any {
      return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed);
    }
    async function driveDirect(t: any, uid: number, boardNo: number): Promise<any> {
      const b = gameMod.loadBoard(t, uid, boardNo, true)!;
      await gameMod.ensureAdvanced(b);
      let view = gameMod.boardView(t, b, 1200);
      let safety = 250;
      while (view.state !== 'done' && safety-- > 0) {
        if (view.state === 'bidding' && view.myTurn) await gameMod.submitCall(b, 0);
        else if (view.state === 'playing' && view.myTurn) await gameMod.submitPlay(b, (view.legalCards as number[])[0]);
        else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
        view = gameMod.boardView(t, b, 1200);
      }
      if (view.state !== 'done') throw new Error('board did not finish');
      return b;
    }
    async function playRehearsalOut(rehTournamentId: number, uid: number, boardNo: number): Promise<any> {
      const t = tournamentRow(rehTournamentId);
      const b = gameMod.loadBoard(t, uid, boardNo, false)!;
      let view = gameMod.boardView(t, b, 1200);
      let safety = 250;
      while (view.state !== 'done' && safety-- > 0) {
        if (view.state === 'bidding' && view.myTurn) await gameMod.submitCall(b, 0);
        else if (view.state === 'playing' && view.myTurn) await gameMod.submitPlay(b, (view.legalCards as number[])[0]);
        else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
        view = gameMod.boardView(t, b, 1200);
      }
      if (view.state !== 'done') throw new Error('rehearsal board did not finish');
      return view;
    }
    // Retries across board numbers to dodge a pass-out or a claim right at
    // ply 0 (see finishedBoard's own doc comment above for why both are
    // possible) — same shape, just against the direct engine calls.
    async function rehearsableBoard(t: any, uid: number): Promise<{ b: any; branchPly: number }> {
      for (let boardNo = 1; boardNo <= 4; boardNo++) {
        const b = await driveDirect(t, uid, boardNo);
        if (b.contract && b.row.claimed_at_ply !== 0) return { b, branchPly: safeBranchPly(b.row) };
      }
      throw new Error('no rehearsable board found among 4');
    }

    // One-player field: matchpoints() would be the meaningless n<=1
    // placeholder — the server must refuse to invent a number.
    const lonely = makeUser('rehearsal-mp-lonely');
    const tLonely = makeTournament('rehearsal-mp-lonely');
    const { b: originLonely, branchPly: plyLonely } = await rehearsableBoard(tLonely, lonely);
    const rehLonely = await rehearsalMod.createRehearsal(tLonely, lonely, originLonely.row.board_no, plyLonely);
    const vLonely = await playRehearsalOut(rehLonely.tournamentId, lonely, rehLonely.boardNo);
    expect(vLonely.originResult.field.length).toBe(1);
    expect(vLonely.lineMatchpoints).toBeNull();

    // Two-player field: substitute — never append — this line's score for
    // the player's own row, and matchpoint that.
    const carol = makeUser('rehearsal-mp-carol');
    const dave = makeUser('rehearsal-mp-dave');
    const tShared = makeTournament('rehearsal-mp-shared');
    const { b: originCarol, branchPly: plyShared } = await rehearsableBoard(tShared, carol);
    await driveDirect(tShared, dave, originCarol.row.board_no); // same tournament, same board — one real field

    const rehCarol = await rehearsalMod.createRehearsal(tShared, carol, originCarol.row.board_no, plyShared);
    const vCarol = await playRehearsalOut(rehCarol.tournamentId, carol, rehCarol.boardNo);
    expect(vCarol.originResult.field.length).toBe(2);

    const rows = boardFieldRows(tShared.id, originCarol.row.board_no);
    const myIndex = rows.findIndex((r) => r.user_id === carol);
    expect(myIndex).toBeGreaterThanOrEqual(0);

    const realScores = rows.map((r) => r.score_ns ?? 0);
    const expectedOldPct = Math.round(matchpoints(realScores)[myIndex].pct * 10) / 10;
    expect(vCarol.originResult.pct).toBe(expectedOldPct);

    const substitutedScores = [...realScores];
    substitutedScores[myIndex] = vCarol.result.scoreNS;
    const expectedNewPct = Math.round(matchpoints(substitutedScores)[myIndex].pct * 10) / 10;
    expect(vCarol.lineMatchpoints).toBe(expectedNewPct);
  }, 60_000);
});

describe('GET .../rehearsals', () => {
  it('lists every FINISHED attempt on this origin board, newest first, scoped to the caller', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);
    // Two distinct attempts at the SAME ply requires finishing the first —
    // see 'resuming an in-progress attempt' below for what a repeat tap
    // while the first is still open does instead.
    const first = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    await playBoard(alice, first.tournamentId, first.boardNo);
    const second = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    expect(second.tournamentId).not.toBe(first.tournamentId);

    const { rehearsals } = await alice.get(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals`);
    const ids = rehearsals.map((r: { tournamentId: number }) => r.tournamentId);
    expect(ids[0]).toBe(second.tournamentId); // newest first
    expect(ids).toContain(first.tournamentId);
    expect(rehearsals.every((r: { branchPly: number }) => r.branchPly === branchPly)).toBe(true);

    // Bob never rehearsed this board — his own call must not see Alice's attempts.
    const bobsBoard = await finishedBoard(bob);
    const bobsList = await bob.get(`/api/tournaments/${bobsBoard.tournamentId}/boards/${bobsBoard.boardNo}/rehearsals`);
    expect(bobsList.rehearsals).toEqual([]);
  });
});

describe('resuming an in-progress attempt', () => {
  it('a repeat POST at the same ply resumes the still-open attempt instead of creating another', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);

    const first = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const repeat = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    expect(repeat).toEqual(first);

    const { rehearsals } = await alice.get(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals`);
    expect(rehearsals.filter((r: { branchPly: number }) => r.branchPly === branchPly).length).toBe(1);
  });

  it('a DIFFERENT branch ply is unaffected by an in-progress attempt elsewhere on the board', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);
    if (branchPly === 0) return; // needs a second, distinct valid ply below it
    const a = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const b = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly - 1 });
    expect(a.tournamentId).not.toBe(b.tournamentId);
  });

  it('once an attempt finishes, the same ply is open again for a genuinely new one', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);

    const first = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    await playBoard(alice, first.tournamentId, first.boardNo);
    const second = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    expect(second.tournamentId).not.toBe(first.tournamentId);
  });
});

describe('DELETE .../rehearsals/:rehearsalId', () => {
  it('discards an attempt outright — it stops appearing in the listing and its rows are gone', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });

    const res = await alice.raw(
      'DELETE',
      `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals/${created.tournamentId}`,
    );
    expect(res.statusCode).toBe(200);

    const { rehearsals } = await alice.get(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals`);
    expect(rehearsals.some((r: { tournamentId: number }) => r.tournamentId === created.tournamentId)).toBe(false);
    expect(tournamentRow(created.tournamentId)).toBeUndefined();
    expect(boardRow(created.tournamentId)).toBeUndefined();
  });

  it('discarding frees the branch ply for a genuinely fresh attempt, not a resume of the deleted progress', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);
    const first = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const freshPlaysLen = JSON.parse(boardRow(first.tournamentId).plays).length;

    // Advance the discarded attempt a card, if it's the human's turn — a
    // resumed (rather than freshly created) row would carry this forward.
    const firstView = await alice.get(`/api/tournaments/${first.tournamentId}/boards/${first.boardNo}`);
    if (firstView.state === 'playing' && firstView.legalCards?.length) {
      await alice.post(`/api/tournaments/${first.tournamentId}/boards/${first.boardNo}/play`, {
        card: firstView.legalCards[0],
      });
    }

    await alice.raw('DELETE', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals/${first.tournamentId}`);

    // Note: SQLite reuses a deleted row's rowid for the next insert on a
    // non-AUTOINCREMENT table, so `second.tournamentId` can legitimately
    // equal `first.tournamentId` — that alone proves nothing. What matters
    // is the CONTENT: a fresh row's plays[] length matches what the FIRST
    // attempt had right after creation (deterministic, same seed/prefix),
    // not the longer one that included the extra card played above.
    const second = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const secondPlays = JSON.parse(boardRow(second.tournamentId).plays);
    expect(secondPlays.slice(0, branchPly)).toEqual(JSON.parse(origin.plays).slice(0, branchPly));
    expect(secondPlays.length).toBe(freshPlaysLen);
  });

  it("404s discarding someone else's rehearsal", async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });

    const res = await bob.raw(
      'DELETE',
      `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals/${created.tournamentId}`,
    );
    expect(res.statusCode).toBe(404);

    // Untouched — the refused delete didn't quietly succeed.
    const { rehearsals } = await alice.get(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals`);
    expect(rehearsals.some((r: { tournamentId: number }) => r.tournamentId === created.tournamentId)).toBe(true);
  });

  it('404s when the origin (tournamentId, boardNo) in the URL does not match the rehearsal', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const created = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, {
      ply: safeBranchPly(origin),
    });

    const otherBoard = await finishedBoard(bob);
    const res = await alice.raw(
      'DELETE',
      `/api/tournaments/${otherBoard.tournamentId}/boards/${otherBoard.boardNo}/rehearsals/${created.tournamentId}`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('404s an id that is not a rehearsal tournament at all', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const res = await alice.raw('DELETE', `/api/tournaments/${tournamentId}/boards/${boardNo}/rehearsals/${tournamentId}`);
    expect(res.statusCode).toBe(404);
  });
});
