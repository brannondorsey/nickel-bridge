import { randomBytes } from 'node:crypto';
import { eloUpdates, matchpoints } from '@bridge/core';
import { BoardRow, TournamentRow, db } from './db.js';
import { BOARDS_PER_TOURNAMENT } from './game.js';

const WINDOW_DAYS = Number(process.env.TOURNAMENT_WINDOW_DAYS ?? 7);

const stmtOpenExpired = db.prepare(`SELECT * FROM tournaments WHERE status = 'open' AND closes_at <= unixepoch()`);
const stmtClose = db.prepare(`UPDATE tournaments SET status = 'closed' WHERE id = ?`);
const stmtTournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`);
const stmtDoneBoards = db.prepare(
  `SELECT b.*, u.name AS user_name, u.elo AS user_elo FROM boards b JOIN users u ON u.id = b.user_id
   WHERE b.tournament_id = ? AND b.state = 'done'`,
);
const stmtMyUnfinished = db.prepare(
  `SELECT t.* FROM tournaments t
   WHERE t.status = 'open' AND t.closes_at > unixepoch()
     AND EXISTS (SELECT 1 FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ?)
     AND (SELECT COUNT(*) FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ? AND b.state = 'done') < ?
   ORDER BY t.created_at LIMIT 1`,
);
const stmtJoinable = db.prepare(
  `SELECT t.*, (SELECT COUNT(*) FROM boards b WHERE b.tournament_id = t.id AND b.state = 'done') AS plays
   FROM tournaments t
   WHERE t.status = 'open' AND t.closes_at > unixepoch()
     AND NOT EXISTS (SELECT 1 FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ?)
   ORDER BY plays DESC, t.created_at ASC LIMIT 1`,
);
const stmtCreateTournament = db.prepare(
  `INSERT INTO tournaments (name, seed, closes_at) VALUES (?, ?, unixepoch() + ?) RETURNING *`,
);
const stmtRenameTournament = db.prepare(`UPDATE tournaments SET name = ? WHERE id = ?`);
const stmtUserElo = db.prepare(`SELECT elo FROM users WHERE id = ?`);
const stmtSetElo = db.prepare(`UPDATE users SET elo = ? WHERE id = ?`);
const stmtEloHistory = db.prepare(
  `INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`,
);
const stmtEloDone = db.prepare(`SELECT COUNT(*) AS n FROM elo_history WHERE tournament_id = ?`);
const stmtMyBoardCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
const stmtMyTournaments = db.prepare(
  `SELECT DISTINCT t.* FROM tournaments t JOIN boards b ON b.tournament_id = t.id
   WHERE b.user_id = ? ORDER BY t.created_at DESC LIMIT 20`,
);

export interface Standing {
  userId: number;
  name: string;
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
  eloDelta?: number;
}

/**
 * Standings from completed boards: each board is matchpointed across the
 * users who finished it; a user's total is the average over their finished
 * boards. Users who finished all boards get final ranks.
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
  let rank = 0;
  list.forEach((s, i) => {
    if (s.complete) {
      rank = i + 1;
      s.rank = list.filter((o, j) => j < i && o.complete && (o.totalPct ?? 0) > (s.totalPct ?? 0)).length + 1;
    }
  });
  return list;
}

/** Close expired tournaments and apply Elo. Called lazily before reads/writes. */
export function closeExpired(): void {
  const expired = stmtOpenExpired.all() as TournamentRow[];
  for (const t of expired) {
    finalize(t);
  }
}

function finalize(t: TournamentRow): void {
  const apply = db.transaction(() => {
    stmtClose.run(t.id);
    const already = (stmtEloDone.get(t.id) as { n: number }).n;
    if (already > 0) return;
    const finalStandings = standings(t.id).filter((s) => s.complete);
    if (finalStandings.length < 2) return;
    const participants = finalStandings.map((s) => ({
      userId: s.userId,
      rating: (stmtUserElo.get(s.userId) as { elo: number }).elo,
      totalPct: s.totalPct ?? 0,
    }));
    for (const r of eloUpdates(participants)) {
      stmtSetElo.run(r.after, r.userId);
      stmtEloHistory.run(r.userId, t.id, r.before, r.after);
    }
  });
  apply();
}

/**
 * Just-in-time placement:
 *  1. resume an open tournament the user has started but not finished,
 *  2. else join the open tournament with the most completed plays,
 *  3. else create a fresh one.
 */
export function placeUser(userId: number): { tournament: TournamentRow; nextBoard: number } {
  closeExpired();
  let t = stmtMyUnfinished.get(userId, userId, BOARDS_PER_TOURNAMENT) as TournamentRow | undefined;
  if (!t) t = stmtJoinable.get(userId) as TournamentRow | undefined;
  if (!t) {
    t = stmtCreateTournament.get('Tournament', randomBytes(16).toString('hex'), WINDOW_DAYS * 86400) as TournamentRow;
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
