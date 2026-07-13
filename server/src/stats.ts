import { Contract, ELO_INITIAL } from '@bridge/core';
import { db } from './db.js';
import { standings } from './tournaments.js';

const stmtUser = db.prepare(`SELECT id, name, picture, elo, created_at FROM users WHERE id = ?`);
// elo_history is wiped and replayed in tournament-id order on every recompute,
// so created_at is meaningless there — tournament_id IS the rating timeline.
// finished_at (the user's last completed board of the tournament) is only a label.
const stmtEloSeries = db.prepare(
  `SELECT h.tournament_id, h.after, t.name AS tournament_name,
          (SELECT MAX(b.updated_at) FROM boards b
            WHERE b.tournament_id = h.tournament_id AND b.user_id = h.user_id AND b.state = 'done') AS finished_at
   FROM elo_history h JOIN tournaments t ON t.id = h.tournament_id
   WHERE h.user_id = ? ORDER BY h.tournament_id`,
);
const stmtDoneBoards = db.prepare(
  `SELECT b.tournament_id, b.bid_evals, b.contract, b.tricks_declarer, b.updated_at, t.name AS tournament_name
   FROM boards b JOIN tournaments t ON t.id = b.tournament_id
   WHERE b.user_id = ? AND b.state = 'done' ORDER BY b.updated_at, b.id`,
);
const stmtRatedElos = db.prepare(
  `SELECT elo FROM users WHERE EXISTS (SELECT 1 FROM elo_history h WHERE h.user_id = users.id)`,
);
const stmtAllDoneEvals = db.prepare(`SELECT user_id, bid_evals FROM boards WHERE state = 'done'`);
const stmtAllTournamentIds = db.prepare(`SELECT id FROM tournaments ORDER BY id`);

export interface StatPoint {
  tournamentId: number;
  tournamentName: string;
  finishedAt: number | null;
}

export interface PlayerStats {
  user: { id: number; name: string; picture: string | null; elo: number; createdAt: number };
  totals: {
    boardsCompleted: number;
    tournamentsPlayed: number;
    tournamentsCompleted: number;
    ratedTournaments: number;
    currentElo: number;
    peakElo: number;
    avgPct: number | null;
    avgBidAccuracy: number | null;
    gradeCounts: { excellent: number; good: number; fair: number; poor: number };
    declarer: { boards: number; made: number };
    defense: { boards: number; beat: number };
    passedOut: number;
  };
  /** "better than N% of players" per metric; null when the player or field lacks data */
  percentiles: {
    elo: number | null;
    avgPct: number | null;
    bidAccuracy: number | null;
    ratedPlayers: number;
    activePlayers: number;
  };
  eloSeries: (StatPoint & { elo: number })[];
  pctSeries: (StatPoint & { pct: number; boards: number; fieldSize: number })[];
  accuracySeries: (StatPoint & { accuracy: number | null; calls: number })[];
}

interface EvalRow {
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  score: number;
}

interface DoneBoardRow {
  tournament_id: number;
  bid_evals: string;
  contract: string | null;
  tricks_declarer: number | null;
  updated_at: number;
  tournament_name: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** share of *other* players this value beats, 0..100; null without a comparison field */
function betterThan(value: number, field: number[]): number | null {
  if (field.length < 2) return null;
  const below = field.filter((v) => v < value).length;
  return Math.round((below / (field.length - 1)) * 100);
}

export function playerStats(userId: number): PlayerStats | null {
  const u = stmtUser.get(userId) as
    | { id: number; name: string; picture: string | null; elo: number; created_at: number }
    | undefined;
  if (!u) return null;

  const eloRows = stmtEloSeries.all(userId) as {
    tournament_id: number;
    after: number;
    tournament_name: string;
    finished_at: number | null;
  }[];
  const eloSeries = eloRows.map((r) => ({
    tournamentId: r.tournament_id,
    tournamentName: r.tournament_name,
    finishedAt: r.finished_at,
    elo: r.after,
  }));

  const boards = stmtDoneBoards.all(userId) as DoneBoardRow[];

  const gradeCounts = { excellent: 0, good: 0, fair: 0, poor: 0 };
  const declarer = { boards: 0, made: 0 };
  const defense = { boards: 0, beat: 0 };
  let passedOut = 0;
  const allScores: number[] = [];
  const byTournament = new Map<number, { name: string; finishedAt: number; scores: number[] }>();

  for (const b of boards) {
    const t = byTournament.get(b.tournament_id) ?? { name: b.tournament_name, finishedAt: 0, scores: [] };
    t.finishedAt = Math.max(t.finishedAt, b.updated_at);
    for (const e of JSON.parse(b.bid_evals) as EvalRow[]) {
      gradeCounts[e.grade]++;
      t.scores.push(e.score);
      allScores.push(e.score);
    }
    byTournament.set(b.tournament_id, t);

    const contract = b.contract ? (JSON.parse(b.contract) as Contract) : null;
    if (!contract) {
      passedOut++;
    } else if (contract.declarer % 2 === 0) {
      // the human always sits N-S, so an even declarer seat is the user's side
      declarer.boards++;
      if ((b.tricks_declarer ?? 0) >= 6 + contract.level) declarer.made++;
    } else {
      defense.boards++;
      if ((b.tricks_declarer ?? 0) < 6 + contract.level) defense.beat++;
    }
  }

  // ordered by the user's play order — their learning timeline
  const tournaments = [...byTournament.entries()].sort((a, b) => a[1].finishedAt - b[1].finishedAt);

  const accuracySeries = tournaments.map(([tid, t]) => ({
    tournamentId: tid,
    tournamentName: t.name,
    finishedAt: t.finishedAt,
    accuracy: t.scores.length ? Math.round(mean(t.scores) * 100) : null,
    calls: t.scores.length,
  }));

  let tournamentsCompleted = 0;
  const pctSeries = tournaments.flatMap(([tid, t]) => {
    const field = standings(tid);
    const mine = field.find((s) => s.userId === userId);
    if (!mine || mine.totalPct === null) return [];
    if (mine.complete) tournamentsCompleted++;
    return [
      {
        tournamentId: tid,
        tournamentName: t.name,
        finishedAt: t.finishedAt,
        pct: mine.totalPct,
        boards: mine.boardsDone,
        fieldSize: field.length,
      },
    ];
  });

  const avgPct = pctSeries.length ? round1(mean(pctSeries.map((p) => p.pct))) : null;
  const avgBidAccuracy = allScores.length ? Math.round(mean(allScores) * 100) : null;

  return {
    user: { id: u.id, name: u.name, picture: u.picture, elo: u.elo, createdAt: u.created_at },
    totals: {
      boardsCompleted: boards.length,
      tournamentsPlayed: byTournament.size,
      tournamentsCompleted,
      ratedTournaments: eloSeries.length,
      currentElo: u.elo,
      peakElo: Math.max(ELO_INITIAL, ...eloSeries.map((e) => e.elo)),
      avgPct,
      avgBidAccuracy,
      gradeCounts,
      declarer,
      defense,
      passedOut,
    },
    percentiles: fieldPercentiles(userId, u.elo, eloSeries.length > 0, avgPct, avgBidAccuracy),
    eloSeries,
    pctSeries,
    accuracySeries,
  };
}

/**
 * Where the player sits in the whole field, per metric. Populations differ on
 * purpose: elo only means something for rated players, while score/accuracy
 * compare against everyone who has completed at least one board.
 */
function fieldPercentiles(
  userId: number,
  elo: number,
  isRated: boolean,
  avgPct: number | null,
  avgBidAccuracy: number | null,
): PlayerStats['percentiles'] {
  const ratedElos = (stmtRatedElos.all() as { elo: number }[]).map((r) => r.elo);

  // mean bid-eval score per user across all completed boards
  const scoresByUser = new Map<number, number[]>();
  for (const row of stmtAllDoneEvals.all() as { user_id: number; bid_evals: string }[]) {
    const list = scoresByUser.get(row.user_id) ?? [];
    for (const e of JSON.parse(row.bid_evals) as EvalRow[]) list.push(e.score);
    scoresByUser.set(row.user_id, list);
  }
  const accuracies = [...scoresByUser.values()]
    .filter((s) => s.length)
    .map((s) => Math.round(mean(s) * 100));

  // tournament-weighted mean pct per user, from one standings() pass per tournament
  const pctsByUser = new Map<number, number[]>();
  for (const { id } of stmtAllTournamentIds.all() as { id: number }[]) {
    for (const s of standings(id)) {
      if (s.totalPct === null) continue;
      pctsByUser.set(s.userId, [...(pctsByUser.get(s.userId) ?? []), s.totalPct]);
    }
  }
  const avgPcts = [...pctsByUser.values()].map((p) => round1(mean(p)));

  return {
    elo: isRated ? betterThan(elo, ratedElos) : null,
    avgPct: avgPct !== null ? betterThan(avgPct, avgPcts) : null,
    bidAccuracy: avgBidAccuracy !== null ? betterThan(avgBidAccuracy, accuracies) : null,
    ratedPlayers: ratedElos.length,
    activePlayers: scoresByUser.size,
  };
}
