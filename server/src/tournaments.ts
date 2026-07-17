import { randomBytes } from 'node:crypto';
import { Contract, ELO_INITIAL, contractLabel, eloUpdates, matchpoints } from '@bridge/core';
import { BOARDS_PER_TOURNAMENT, BoardRow, TournamentRow, db } from './db.js';

const stmtTournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`);
const stmtDoneBoards = db.prepare(
  `SELECT b.*, u.handle AS user_handle FROM boards b JOIN users u ON u.id = b.user_id
   WHERE b.tournament_id = ? AND b.state = 'done'`,
);
// Placement, the lobby list, and the Elo replay all exclude demo-mode
// exhibit tournaments (kind = 'exhibit', created only by demo.ts): a
// half-played scenario board must never hijack the resume tier,
// grace-capture other players, head the lobby's crossings, or enter the
// rating replay. Production is unaffected — every tournament created here is
// kind 'standard' (the schema default), so the filter matches nothing there.
const stmtMyUnfinished = db.prepare(
  `SELECT t.* FROM tournaments t
   WHERE EXISTS (SELECT 1 FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ?)
     AND (SELECT COUNT(*) FROM boards b WHERE b.tournament_id = t.id AND b.user_id = ? AND b.state = 'done') < ?
     AND t.kind = 'standard'
   ORDER BY t.created_at LIMIT 1`,
);
// Every tournament the user has never touched, created within the backlog
// window, with distinct-finisher and distinct-starter counts. One query feeds
// both the grace tier and the scoring tier of chooseTournament(). The LEFT
// JOIN keeps zero-board tournaments (they are grace targets with starters = 0);
// COUNT(DISTINCT CASE ...) yields 0, not NULL, when nobody has finished.
// Tournaments older than the window are "archived": never candidates, but the
// resume tier below is window-free and boards create lazily on GET, so they
// stay resumable and completable via direct URL.
const stmtCandidates = db.prepare(
  `SELECT t.*,
          COUNT(DISTINCT CASE WHEN b.state = 'done' THEN b.user_id END) AS done_players,
          COUNT(DISTINCT b.user_id) AS starters
   FROM tournaments t
   LEFT JOIN boards b ON b.tournament_id = t.id
   WHERE t.created_at > ?
     AND NOT EXISTS (SELECT 1 FROM boards mb WHERE mb.tournament_id = t.id AND mb.user_id = ?)
     AND t.kind = 'standard'
   GROUP BY t.id`,
);
const stmtCreateTournament = db.prepare(`INSERT INTO tournaments (name, seed) VALUES (?, ?) RETURNING *`);
const stmtRenameTournament = db.prepare(`UPDATE tournaments SET name = ? WHERE id = ?`);
const stmtMyBoardCount = db.prepare(
  `SELECT COUNT(*) AS n FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
const stmtMyTournaments = db.prepare(
  `SELECT DISTINCT t.* FROM tournaments t JOIN boards b ON b.tournament_id = t.id
   WHERE b.user_id = ? AND t.kind = 'standard' ORDER BY t.created_at DESC LIMIT 20`,
);
// kind filter: "exhibits never rate" is enforced here, not assumed — even if
// testers complete all four boards of an exhibit by direct URL, it never
// enters the replay.
const stmtAllTournamentIds = db.prepare(`SELECT id FROM tournaments WHERE kind = 'standard' ORDER BY id`);
const stmtClearEloHistory = db.prepare(`DELETE FROM elo_history`);
const stmtResetElo = db.prepare(`UPDATE users SET elo = ?`);
const stmtSetElo = db.prepare(`UPDATE users SET elo = ? WHERE id = ?`);
const stmtEloHistory = db.prepare(
  `INSERT INTO elo_history (user_id, tournament_id, before, after) VALUES (?, ?, ?, ?)`,
);
const stmtAllEloHistory = db.prepare(
  `SELECT user_id, tournament_id, after FROM elo_history ORDER BY tournament_id`,
);
const stmtMyEloDelta = db.prepare(
  `SELECT before, after FROM elo_history WHERE user_id = ? AND tournament_id = ?`,
);
const stmtMyLastPlayed = db.prepare(
  `SELECT MAX(updated_at) AS at FROM boards WHERE tournament_id = ? AND user_id = ? AND state = 'done'`,
);
const stmtMyBoards = db.prepare(
  `SELECT * FROM boards WHERE tournament_id = ? AND user_id = ? ORDER BY board_no`,
);

interface Standing {
  userId: number;
  handle: string;
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
  const rows = stmtDoneBoards.all(tournamentId) as (BoardRow & { user_handle: string })[];
  const users = new Map<number, { handle: string; pcts: number[] }>();
  for (let no = 1; no <= BOARDS_PER_TOURNAMENT; no++) {
    const boardRows = rows.filter((r) => r.board_no === no);
    if (!boardRows.length) continue;
    const mps = matchpoints(boardRows.map((r) => r.score_ns ?? 0));
    boardRows.forEach((r, i) => {
      const u = users.get(r.user_id) ?? { handle: r.user_handle, pcts: [] };
      u.pcts.push(mps[i].pct);
      users.set(r.user_id, u);
    });
  }
  const list: Standing[] = [...users.entries()].map(([userId, u]) => ({
    userId,
    handle: u.handle,
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
 * Placement tuning. Ages and windows are in seconds (created_at is unixepoch
 * seconds). These are playtest knobs, deliberately kept in one place: TAU_S
 * is the knob to shrink once the group grows beyond a handful of daily
 * players; the threshold is derived from the scoring function itself rather
 * than being a separate constant.
 */
export const PLACEMENT = {
  /** Decay time constant: how fast a tournament's appeal fades with age. */
  TAU_S: 30 * 86400,
  /** Newly created tournaments are force-served for up to this long... */
  GRACE_TTL_S: 48 * 3600,
  /** ...until they have this many distinct starters (creator + 3 friends). */
  GRACE_CAP: 4,
  /** Only tournaments created within this window are placement candidates. */
  BACKLOG_WINDOW_S: 30 * 86400,
  /** Weighted-sample among candidates within this fraction of the top score. */
  SAMPLE_RATIO: 0.8,
  /** Threshold: what a brand-new tournament would score (1 finisher, age 0). */
  NEW_TOURNAMENT_SCORE: Math.LN2,
};

export interface PlacementCandidate extends TournamentRow {
  /** Distinct users with >= 1 done board — the comparison-field proxy. */
  done_players: number;
  /** Distinct users with any board row — grace-window occupancy. */
  starters: number;
}

/** Popularity × recency: log(1 + distinct finishers) · e^(−age/τ). */
export function tournamentScore(donePlayers: number, ageSec: number): number {
  return Math.log(1 + donePlayers) * Math.exp(-Math.max(0, ageSec) / PLACEMENT.TAU_S);
}

/**
 * Pick the tournament to serve, or null to create a new one.
 *
 * Grace tier: force-join the oldest young (< GRACE_TTL_S), under-filled
 * (< GRACE_CAP starters) tournament. Fresh tournaments collect their first few
 * players before entering normal scoring instead of dying as 1-player
 * orphans, and two friends who both return after a long absence land on the
 * same deals (first returner creates, second is grace-served into it). Grace
 * slots are occupied by board rows, not placements — boards deal lazily on
 * GET, so several players placed before any of them opens a board can all be
 * graced into the same tournament. Harmless at friends scale.
 *
 * Scoring tier: if the best candidate beats what a brand-new tournament would
 * score (ln 2 — one finisher at age 0), weighted-sample among the candidates
 * within SAMPLE_RATIO of the top (floored at ln 2) so simultaneous arrivals
 * spread across near-equivalent boards instead of piling onto one. Otherwise
 * create. Corollary: outside grace, a candidate needs ≥ 2 distinct finishers
 * to be joined — a lone finisher's score ln 2 · e^(−age/τ) sits below the
 * threshold at any age > 0, deliberately: past its grace window, a 1-player
 * tournament is not worth joining over a fresh board.
 */
export function chooseTournament(
  candidates: PlacementCandidate[],
  nowSec: number,
  rng: () => number,
): PlacementCandidate | null {
  const grace = candidates
    .filter((c) => nowSec - c.created_at < PLACEMENT.GRACE_TTL_S && c.starters < PLACEMENT.GRACE_CAP)
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  if (grace.length) return grace[0];

  const scored = candidates.map((c) => ({ c, score: tournamentScore(c.done_players, nowSec - c.created_at) }));
  const top = scored.reduce((m, x) => Math.max(m, x.score), 0);
  if (top < PLACEMENT.NEW_TOURNAMENT_SCORE) return null;

  const floor = Math.max(PLACEMENT.SAMPLE_RATIO * top, PLACEMENT.NEW_TOURNAMENT_SCORE);
  const pool = scored
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score || a.c.created_at - b.c.created_at || a.c.id - b.c.id);
  let r = rng() * pool.reduce((s, x) => s + x.score, 0);
  for (const x of pool) {
    r -= x.score;
    if (r < 0) return x.c;
  }
  return pool[pool.length - 1].c; // float-drift safety
}

/**
 * Just-in-time placement:
 *  1. resume a tournament the user has started but not finished (window-free:
 *     your own unfinished tournaments never expire on you),
 *  2. else serve a candidate from the backlog window via chooseTournament()
 *     (grace force-join, then popularity × recency scoring with weighted
 *     sampling near the top),
 *  3. else create a fresh one — which the grace tier then fills with the next
 *     few requesters.
 *
 * `nowSec`/`rng` are injectable for tests; production uses the real clock and
 * Math.random. Selection randomness does not touch the robot-determinism
 * invariant (deals derive from the tournament seed, not from placement).
 */
export function placeUser(
  userId: number,
  opts: { nowSec?: number; rng?: () => number } = {},
): { tournament: TournamentRow; nextBoard: number } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const rng = opts.rng ?? Math.random;
  let t = stmtMyUnfinished.get(userId, userId, BOARDS_PER_TOURNAMENT) as TournamentRow | undefined;
  if (!t) {
    const candidates = stmtCandidates.all(nowSec - PLACEMENT.BACKLOG_WINDOW_S, userId) as PlacementCandidate[];
    t = chooseTournament(candidates, nowSec, rng) ?? undefined;
  }
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

export function myTournaments(
  userId: number,
): (TournamentRow & { myDone: number; myLastPlayedAt: number | null })[] {
  const list = stmtMyTournaments.all(userId) as TournamentRow[];
  return list.map((t) => ({
    ...t,
    myDone: (stmtMyBoardCount.get(t.id, userId) as { n: number }).n,
    myLastPlayedAt: (stmtMyLastPlayed.get(t.id, userId) as { at: number | null }).at,
  }));
}

/**
 * Rank movement per rated user: previous rank − current rank, where "previous"
 * is the rating snapshot before the newest rated tournament in elo_history.
 * Null for users first rated at that tournament (no previous snapshot) and for
 * everyone when fewer than two rated tournaments exist. Because elo_history is
 * wiped and replayed on every board completion, movement can shift
 * retroactively when a late finisher re-ranks an old tournament — that is the
 * evergreen-Elo model working as intended.
 */
export function leaderboardMovement(): Map<number, number> {
  const rows = stmtAllEloHistory.all() as { user_id: number; tournament_id: number; after: number }[];
  const movement = new Map<number, number>();
  if (!rows.length) return movement;
  const latestTid = rows[rows.length - 1].tournament_id;
  const prev = new Map<number, number>();
  const current = new Map<number, number>();
  for (const r of rows) {
    if (r.tournament_id < latestTid) prev.set(r.user_id, r.after);
    current.set(r.user_id, r.after);
  }
  // standard competition ranking (ties share a rank), within each snapshot's population
  const rank = (ratings: Map<number, number>, userId: number) =>
    [...ratings.values()].filter((v) => v > ratings.get(userId)!).length + 1;
  for (const userId of current.keys()) {
    if (!prev.has(userId)) continue;
    movement.set(userId, rank(prev, userId) - rank(current, userId));
  }
  return movement;
}

/** The viewer's rating change from one tournament, or null if it never rated. */
export function myEloDelta(tournamentId: number, userId: number): { before: number; after: number } | null {
  const row = stmtMyEloDelta.get(userId, tournamentId) as { before: number; after: number } | undefined;
  return row ?? null;
}

interface MyBoardSummary {
  no: number;
  state: BoardRow['state'];
  contractLabel: string | null;
  scoreNS: number | null;
  pct: number | null;
}

/**
 * The viewer's started boards with their field matchpoint pct, matching the
 * numbers boardResult() reports on the board's own result view (same rounding,
 * same matchpoints() field).
 */
export function myBoardSummaries(tournamentId: number, userId: number): MyBoardSummary[] {
  const mine = stmtMyBoards.all(tournamentId, userId) as BoardRow[];
  if (!mine.length) return [];
  const done = stmtDoneBoards.all(tournamentId) as (BoardRow & { user_handle: string })[];
  return mine.map((b) => {
    if (b.state !== 'done') return { no: b.board_no, state: b.state, contractLabel: null, scoreNS: null, pct: null };
    const field = done.filter((r) => r.board_no === b.board_no);
    const mps = matchpoints(field.map((r) => r.score_ns ?? 0));
    const i = field.findIndex((r) => r.user_id === userId);
    return {
      no: b.board_no,
      state: b.state,
      contractLabel: b.contract
        ? contractLabel(JSON.parse(b.contract) as Contract, b.tricks_declarer ?? undefined)
        : 'Passed out',
      scoreNS: b.score_ns,
      pct: i >= 0 ? Math.round(mps[i].pct * 10) / 10 : null,
    };
  });
}
