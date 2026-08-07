import { Contract, contractLabel } from '@bridge/core';
import { deriveClaimBoundary } from './analyze.js';
import { TournamentRow, db } from './db.js';
import { GameBoard, ensureAdvanced, httpError, loadBoard } from './game.js';

/**
 * "Play From Here" — branching a FINISHED board's real play at `branchPly`
 * into a new, live, ordinary hidden-hand board the player actually plays out
 * themselves, against the origin board's own robots at the origin's own
 * difficulty. Never scored: see the kind='rehearsal' allowlist exclusion
 * documented on TournamentRow.kind in db.ts.
 *
 * A rehearsal is implemented as its own single-board tournament rather than
 * a parallel play surface, the same move demo mode's kind='exhibit'
 * tournaments already make (see ensureExhibitTournament in demo.ts) — every
 * placement/lobby/Elo-replay/leaderboard/stats/activity-feed query in this
 * codebase is an ALLOWLIST on kind='standard', so a new kind value is
 * excluded from all of them for free, with zero of those call sites touched.
 * This also means the ordinary game.ts machinery (advanceRobots/submitPlay/
 * boardView) needs no changes at all beyond boardView's own small rehearsal-
 * metadata addition — it's just another board row.
 */

const stmtCreateRehearsalTournament = db.prepare(`
  INSERT INTO tournaments (name, seed, kind, difficulty, board_difficulties, origin_tournament_id, origin_board_no, branch_ply)
  VALUES (?, ?, 'rehearsal', ?, ?, ?, ?, ?) RETURNING *
`);
const stmtInsertRehearsalBoard = db.prepare(`
  INSERT INTO boards (tournament_id, user_id, board_no, state, calls, plays, bid_evals, contract)
  VALUES (?, ?, ?, 'playing', ?, ?, ?, ?)
`);

/**
 * One tournament row + its one board row, atomically — never a tournament
 * with no board, or a board pointing at a half-created tournament.
 */
const createRehearsalTx = db.transaction(
  (origin: TournamentRow, userId: number, originBoardNo: number, b: GameBoard, branchPly: number): TournamentRow => {
    const trick = Math.floor(branchPly / 4) + 1;
    const t = stmtCreateRehearsalTournament.get(
      `Rehearsal — Board ${originBoardNo}, from Trick ${trick}`,
      // SAME seed as the origin, deliberately — see the doc comment on
      // createRehearsal below for why this is correct rather than a
      // collision risk.
      origin.seed,
      origin.difficulty,
      origin.board_difficulties,
      origin.id,
      originBoardNo,
      branchPly,
    ) as TournamentRow;
    stmtInsertRehearsalBoard.run(
      t.id,
      userId,
      originBoardNo,
      // The auction never branches — calls/bidEvals/contract are simply the
      // origin's, verbatim. Only `plays` is truncated at the branch point;
      // everything from there on is the player's to redecide.
      JSON.stringify(b.calls),
      JSON.stringify(b.plays.slice(0, branchPly)),
      JSON.stringify(b.bidEvals),
      JSON.stringify(b.contract),
    );
    return t;
  },
);

/**
 * Create a rehearsal from a real, finished board at `branchPly` (a plays[]
 * index — see analyze.ts's AnalysisMoment/AnalysisPly doc comments for the
 * convention: branchPly cards already happened, plays[branchPly] onward is
 * the player's to redecide). Reuses the origin tournament's OWN seed and the
 * origin board's OWN board_no rather than minting fresh ones:
 *
 * - dealBoard(seed, boardNo) (packages/core/src/deck.ts) depends on exactly
 *   that pair, so this alone is what makes the rehearsal's deal, dealer and
 *   vulnerability byte-identical to the origin's.
 * - mcDecisionSeed/bidDecisionSeed (packages/ai) depend only on
 *   (tournamentSeed, boardNo, decisionIndex) — never tournament id — so
 *   reusing the origin's seed is desirable, not a collision: if the player
 *   redecides nothing differently, every downstream robot decision
 *   reproduces the real game byte-for-byte; if they diverge, the same seed
 *   still applies to a genuinely different position (a different calls/plays
 *   prefix), producing a different but still fully deterministic outcome. Do
 *   not "fix" this into a fresh random seed.
 */
export async function createRehearsal(
  origin: TournamentRow,
  userId: number,
  originBoardNo: number,
  branchPly: number,
): Promise<{ tournamentId: number; boardNo: number }> {
  // One level deep only — a rehearsal can never itself be rehearsed. The web
  // client only ever calls this with a top-level origin's own ids, but the
  // route takes an arbitrary tournament id, so this has to be enforced here
  // rather than assumed from the caller.
  if (origin.kind === 'rehearsal') throw httpError(400, 'cannot rehearse a rehearsal');
  const originBoard = loadBoard(origin, userId, originBoardNo, false);
  if (!originBoard || originBoard.row.state !== 'done') throw httpError(404, 'origin board not finished');
  if (!originBoard.contract) throw httpError(400, 'a passed-out board has no play to rehearse');
  if (!Number.isInteger(branchPly) || branchPly < 0 || branchPly >= originBoard.plays.length) {
    throw httpError(400, 'invalid branch ply');
  }
  const boundary =
    originBoard.row.claimed_at_ply ??
    (await deriveClaimBoundary(originBoard.deal, originBoard.contract, originBoard.plays));
  if (boundary !== null && branchPly >= boundary) {
    throw httpError(400, 'cannot branch past the claim boundary — the server played both sides from there');
  }
  const t = createRehearsalTx(origin, userId, originBoardNo, originBoard, branchPly);
  const b = loadBoard(t, userId, originBoardNo, false)!;
  await ensureAdvanced(b); // fast-forward any robot turns sitting right at the branch point
  return { tournamentId: t.id, boardNo: originBoardNo };
}

export interface RehearsalSummary {
  tournamentId: number;
  boardNo: number;
  branchPly: number;
  state: 'playing' | 'done';
  createdAt: number;
  contractLabel: string | null;
  scoreNS: number | null;
}

interface RehearsalRow {
  tournament_id: number;
  branch_ply: number;
  created_at: number;
  board_no: number;
  state: 'bidding' | 'playing' | 'done';
  contract: string | null;
  tricks_declarer: number | null;
  score_ns: number | null;
}

const stmtMyRehearsals = db.prepare(`
  SELECT t.id AS tournament_id, t.branch_ply, t.created_at,
         b.board_no, b.state, b.contract, b.tricks_declarer, b.score_ns
  FROM tournaments t JOIN boards b ON b.tournament_id = t.id
  WHERE t.kind = 'rehearsal' AND t.origin_tournament_id = ? AND t.origin_board_no = ? AND b.user_id = ?
  ORDER BY t.created_at DESC, t.id DESC
`);

/**
 * Every rehearsal attempt on this origin board, regardless of branch point —
 * feeds both the per-moment rail (the client filters by branchPly === m.ply)
 * and the board-wide YOUR REHEARSALS list, uncapped ("no cap, just scroll").
 * Ordered newest first; `created_at` is unix-seconds resolution, so `t.id`
 * (assigned in insertion order) breaks ties between attempts created inside
 * the same second rather than leaving their relative order to SQLite's
 * unspecified tie-break.
 *
 * The JOIN on b.user_id IS the ownership check: a rehearsal tournament
 * carries no user id of its own, only its one board row does, so this query
 * can only ever return rows the caller created.
 */
export function listRehearsals(originTournamentId: number, originBoardNo: number, userId: number): RehearsalSummary[] {
  const rows = stmtMyRehearsals.all(originTournamentId, originBoardNo, userId) as RehearsalRow[];
  return rows.map((r) => ({
    tournamentId: r.tournament_id,
    boardNo: r.board_no,
    branchPly: r.branch_ply,
    state: r.state === 'bidding' ? 'playing' : r.state, // a rehearsal never actually enters 'bidding'
    createdAt: r.created_at,
    contractLabel: r.contract ? contractLabel(JSON.parse(r.contract) as Contract, r.tricks_declarer ?? undefined) : null,
    scoreNS: r.state === 'done' ? r.score_ns : null,
  }));
}
