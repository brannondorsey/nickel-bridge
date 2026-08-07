import { beforeAll, describe, expect, it } from 'vitest';
import { TestClient, freshDbEnv, makeApp, playBoard } from './helpers.js';

freshDbEnv('rehearsal');
const app = await makeApp();
const { db } = await import('../src/db.js');

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

describe('GET .../rehearsals', () => {
  it('lists every attempt on this origin board, newest first, scoped to the caller', async () => {
    const { tournamentId, boardNo } = await finishedBoard(alice);
    const origin = boardRow(tournamentId, boardNo);
    const branchPly = safeBranchPly(origin);
    const first = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });
    const second = await alice.post(`/api/tournaments/${tournamentId}/boards/${boardNo}/rehearse`, { ply: branchPly });

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
