import { randomBytes } from 'node:crypto';
import { ELO_INITIAL, eloUpdates, matchpoints } from '@bridge/core';
import { BOARDS_PER_TOURNAMENT, BoardRow, TournamentRow, db } from './db.js';

const stmtTournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`);
const stmtDoneBoards = db.prepare(
  `SELECT b.*, u.name AS user_name FROM boards b JOIN users u ON u.id = b.user_id
   WHERE b.tournament_id = ? AND b.state = 'done'`,
);
const stmtMyUnfinished = db.prepare(
  `SELECT t.* FROM tournaments t
   WHERE EXISTS (SELECT 1 FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ?)
     AND (SELECT COUNT(*) FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ? AND b.state = 'done') < ?
   ORDER BY t.created_at LIMIT 1`,
);
const stmtJoinable = db.prepare(
  `SELECT t.*, (SELECT COUNT(*) FROM boards b WHERE b.tournament_id = t.id AND b.state = 'done') AS plays
   FROM tournaments t
   WHERE NOT EXISTS (SELECT 1 FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ?)
   ORDER BY plays DESC, t.created_at ASC LIMIT 1`,
);
const stmtCreateTournament = db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, ?) RETURNING *`);
const stmtRenameTournament = db.prepare(`UPDATE tournaments SET name = ? WHERE id = ?`);
const stmtMyBoardCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
const stmtMyTournaments = db.prepare(
  `SELECT DISTINCT t.* FROM tournaments t JOIN boards b ON b.tournament_id = t.id
   WHERE b.user_id = ? ORDER BY t.created_at DESC LIMIT 20`,
);
const stmtAllTournamentIds = db.prepare(`SELECT id FROM tournaments ORDER BY id`);
const stmtClearEloHistory = db.prepare(`DELETE FROM elo_history`);
const stmtResetElo = db.prepare(`UPDATE users SET elo = ?`);
const stmtSetElo = db.prepare(`UPDATE users SET elo = ? WHERE id = ?`);
const stmtEloHistory = db.prepare(
  `INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`,
);

export interface Standing {
  userId: number;
  name: string;
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
}

/**
 * Live standings from completed boards: each board is matchpointed across the
 * users who finished it; a user's total is the average over their finished
 * boards. Standings are never "final" — they keep evolving as more friends
 * play the same deals.
 */
export function standings(tournamentId: number): Standing[] {
  const rows = stmtDoneBoards.all(tournamentId) as (BoardRow & { user_name: string })[];
  const users = new Map<number, { name: string; pcts: number[] }>();
  for (let no = 1; no <= BOARDS_PER_TOURNAMENT; no++) {
    const boardRows = rows.filter((r) => r.board_no === no);
    if (!boardRows.length) continue;
    const mps = matchpoints(boardRows.map((r) => r.score_ns ?? 0));
    boardRows.forEach((r, i) => {
      const u = users.get(r.user_id) ?? { name: r.user_name, pcts: [] };
      u.pcts.push(mps[i].pct);
      users.set(r.user_id, u);
    });
  }
  const list: Standing[] = [...users.entries()].map(([userId, u]) => ({
    userId,
    name: u.name,
    boardsDone: u.pcts.length,
    totalPct: u.pcts.length ? Math.round((u.pcts.reduce((a, b) => a + b, 0) / u.pcts.length) * 10) / 10 : null,
    complete: u.pcts.length >= BOARDS_PER_TOURNAMENT,
  }));
  list.sort((a, b) => (b.totalPct ?? -1) - (a.totalPct ?? -1));
  for (const s of list) {
    if (s.complete) {
      // standard competition ranking among complete players (ties share a rank)
      s.rank = list.filter((o) => o.complete && (o.totalPct ?? 0) > (s.totalPct ?? 0)).length + 1;
    }
  }
  return list;
}

/**
 * Continuous Elo: a deterministic full replay of every tournament in id
 * order. Each tournament with 2+ complete players contributes one round of
 * simultaneous pairwise updates based on ratings entering that tournament.
 * Because it recomputes from scratch, a late finisher joining an old
 * tournament changes that tournament's pairwise set and the correction
 * propagates through the whole history — ratings continuously re-rank as the
 * field grows. At friends scale this is a few milliseconds.
 */
export const recomputeElo = db.transaction(() => {
  stmtClearEloHistory.run();
  stmtResetElo.run(ELO_INITIAL);
  const ratings = new Map<number, number>();
  for (const { id } of stmtAllTournamentIds.all() as { id: number }[]) {
    const complete = standings(id).filter((s) => s.complete);
    if (complete.length < 2) continue;
    const participants = complete.map((s) => ({
      userId: s.userId,
      rating: ratings.get(s.userId) ?? ELO_INITIAL,
      totalPct: s.totalPct ?? 0,
    }));
    for (const r of eloUpdates(participants)) {
      ratings.set(r.userId, r.after);
      stmtEloHistory.run(r.userId, id, r.before, r.after);
    }
  }
  for (const [userId, elo] of ratings) {
    stmtSetElo.run(elo, userId);
  }
});

/**
 * Just-in-time placement:
 *  1. resume a tournament the user has started but not finished,
 *  2. else join the tournament with the most completed plays (maximizing the
 *     comparison field),
 *  3. else create a fresh one.
 */
export function placeUser(userId: number): { tournament: TournamentRow; nextBoard: number } {
  let t = stmtMyUnfinished.get(userId, userId, BOARDS_PER_TOURNAMENT) as TournamentRow | undefined;
  if (!t) t = stmtJoinable.get(userId) as TournamentRow | undefined;
  if (!t) {
    t = stmtCreateTournament.get('Tournament', randomBytes(16).toString('hex')) as TournamentRow;
    stmtRenameTournament.run(`Tournament #${t.id}`, t.id);
    t.name = `Tournament #${t.id}`;
  }
  const done = (stmtMyBoardCount.get(t.id, userId) as { n: number }).n;
  return { tournament: t, nextBoard: Math.min(done + 1, BOARDS_PER_TOURNAMENT) };
}

export function getTournament(id: number): TournamentRow | null {
  return (stmtTournament.get(id) as TournamentRow | undefined) ?? null;
}

export function myTournaments(userId: number): (TournamentRow & { myDone: number })[] {
  const list = stmtMyTournaments.all(userId) as TournamentRow[];
  return list.map((t) => ({
    ...t,
    myDone: (stmtMyBoardCount.get(t.id, userId) as { n: number }).n,
  }));
}
