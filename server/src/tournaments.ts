import { randomBytes } from 'node:crypto';
import type { Difficulty } from '@bridge/ai';
import { Contract, ELO_INITIAL, contractLabel, eloUpdates, matchpoints } from '@bridge/core';
import { BOARDS_PER_TOURNAMENT, BoardRow, TournamentRow, aiTieRank, db } from './db.js';

/**
 * The effective robot difficulty of one board — difficulty is a PER-BOARD
 * property (the duplicate-fairness unit is the board, so every player on
 * (tournament, boardNo) gets this same value). `board_difficulties` is a JSON
 * Difficulty[BOARDS_PER_TOURNAMENT]; NULL means uniform at the tournament's
 * tier label, which is also how legacy rows resolve to 'perfect' everywhere.
 * Today placeUser stamps uniform schedules; ramps/mixed schedules are a data
 * change, not a code change.
 */
export function boardDifficulty(t: TournamentRow, boardNo: number): Difficulty {
  if (t.board_difficulties) {
    const schedule = JSON.parse(t.board_difficulties) as Difficulty[];
    const d = schedule[boardNo - 1];
    if (d) return d;
  }
  return t.difficulty;
}

const stmtTournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`);
const stmtDoneBoards = db.prepare(
  `SELECT b.*, u.handle AS user_handle, u.kind AS user_kind, u.google_id AS user_google
   FROM boards b JOIN users u ON u.id = b.user_id
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
// New placement additionally matches the user's robot-difficulty preference —
// a tournament's difficulty is fixed at creation (invariant 1: identical
// robots for every player on a board), so joining means accepting its tier.
// The resume tier above stays difficulty-blind on purpose: switching your
// preference never orphans a tournament you already started.
// Starter/finisher counts are over HUMAN board rows only (u.kind = 'human'):
// the benchmark AI personas finish every marked tournament within about a
// minute of creation, so counting them would close every grace window
// (3 AI + creator = GRACE_CAP) and make fresh tournaments instant
// popularity-score magnets (log(1+3) > the new-tournament threshold). The
// LEFT-JOINed users row is NULL for tournaments with no boards, which the
// CASE expressions treat as not-human — starters/done_players stay 0, not
// NULL. The NOT EXISTS "never touched" check deliberately stays kind-blind:
// it's about the requesting user's own rows.
const stmtCandidates = db.prepare(
  `SELECT t.*,
          COUNT(DISTINCT CASE WHEN u.kind = 'human' AND b.state = 'done' THEN b.user_id END) AS done_players,
          COUNT(DISTINCT CASE WHEN u.kind = 'human' THEN b.user_id END) AS starters
   FROM tournaments t
   LEFT JOIN boards b ON b.tournament_id = t.id
   LEFT JOIN users u ON u.id = b.user_id
   WHERE t.created_at > ?
     AND NOT EXISTS (SELECT 1 FROM boards mb WHERE mb.tournament_id = t.id AND mb.user_id = ?)
     AND t.kind = 'standard'
     AND t.difficulty = ?
   GROUP BY t.id`,
);
// ai_field = 1: every tournament created for real play gets the benchmark AI
// personas (ai-players.ts); the /api/play route enqueues their boards right
// after placement returns. Raw-inserted fixture/test tournaments and demo
// exhibits keep the column's 0 default and never acquire AI rows.
const stmtCreateTournament = db.prepare(
  `INSERT INTO tournaments (name, seed, difficulty, board_difficulties, ai_field) VALUES (?, ?, ?, ?, 1) RETURNING *`,
);
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

export interface Standing {
  userId: number;
  handle: string;
  /** 'ai' rows are the benchmark house personas (see ai-players.ts) — full field members, unrated */
  kind: 'human' | 'ai';
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export const STANDINGS = {
  /** A partial human player (< BOARDS_PER_TOURNAMENT done) whose most
   * recently completed board in this tournament is older than this is
   * presumed to have abandoned it and is dropped from visibleStandings()'s
   * client-facing field — see its doc comment. Purely a display concern:
   * standings() itself never filters on this. */
  ABANDON_TTL_S: 7 * 86400,
};

interface PlayerAgg {
  handle: string;
  kind: 'human' | 'ai';
  google: string;
  pcts: number[];
  /** unixepoch of this player's most recently completed board — display-only
   * (visibleStandings()'s staleness filter); not part of the public Standing
   * shape. */
  lastDoneAt: number;
}

/**
 * The shared aggregation behind standings()/visibleStandings(): one pass over
 * every done board, matchpointed per board across EVERYONE who finished it —
 * humans and the benchmark AI personas in one field. House rows are real
 * pairs here: they earn ranks, count toward the pair count, and shape human
 * pcts exactly like another human would (a deliberate decision — the house is
 * the yardstick, so it competes on the scoresheet; ai-players.ts). The
 * persona/human split survives only where it must: Elo (eloParticipants below
 * — personas never rate and never shape human ratings) and placement
 * (stmtCandidates). A player's total is the average over their finished
 * boards. Standings are never "final" — they keep evolving as more friends
 * play the same deals.
 */
function aggregateStandings(tournamentId: number): { userId: number; agg: PlayerAgg }[] {
  const rows = stmtDoneBoards.all(tournamentId) as (BoardRow & {
    user_handle: string;
    user_kind: 'human' | 'ai';
    user_google: string;
  })[];
  const players = new Map<number, PlayerAgg>();
  for (let no = 1; no <= BOARDS_PER_TOURNAMENT; no++) {
    const boardRows = rows.filter((r) => r.board_no === no);
    const mps = matchpoints(boardRows.map((r) => r.score_ns ?? 0));
    boardRows.forEach((r, i) => {
      const u =
        players.get(r.user_id) ??
        { handle: r.user_handle, kind: r.user_kind, google: r.user_google, pcts: [], lastDoneAt: 0 };
      u.pcts.push(mps[i].pct);
      u.lastDoneAt = Math.max(u.lastDoneAt, r.updated_at);
      players.set(r.user_id, u);
    });
  }
  // Construction order IS the tie order (the pct sort below is stable):
  // humans first — a human is listed above a persona they tie with (they
  // share the same printed rank) — then personas strongest-first (aiTieRank),
  // so a tied trio reads Shark, Regular, Novice.
  return [...players.entries()].sort((a, b) => aiTieRank(a[1].google) - aiTieRank(b[1].google)).map(([userId, agg]) => ({
    userId,
    agg,
  }));
}

function toStandings(entries: { userId: number; agg: PlayerAgg }[]): Standing[] {
  const list: Standing[] = entries.map(({ userId, agg }): Standing => ({
    userId,
    handle: agg.handle,
    kind: agg.kind,
    boardsDone: agg.pcts.length,
    totalPct: avg(agg.pcts),
    complete: agg.pcts.length >= BOARDS_PER_TOURNAMENT,
  }));
  list.sort((a, b) => (b.totalPct ?? -1) - (a.totalPct ?? -1));
  for (const s of list) {
    if (s.complete) {
      // standard competition ranking among complete players of either kind
      // (ties share a rank) — losing to The Shark costs a place
      s.rank = list.filter((o) => o.complete && (o.totalPct ?? 0) > (s.totalPct ?? 0)).length + 1;
    }
  }
  return list;
}

/**
 * Every player with >= 1 scored board in this tournament, unfiltered — the
 * canonical membership rule the rest of the app treats as authoritative:
 * stats.ts's pctSeries (a player's own tournament history), rivalries()
 * (explicitly documented as NOT gated on completeness, so two players who
 * merely crossed paths mid-tournament still count as rivals), and
 * fieldPercentiles() (the site-wide percentile pool) all depend on this
 * exact contract and must keep calling standings() directly rather than
 * visibleStandings() below — filtering here would silently drop a player's
 * own history, a still-valid rivalry, or a percentile-pool member the moment
 * they went quiet, which is normal in an evergreen app that never forces
 * completion. See visibleStandings() for the client-facing field, which
 * layers a display-only staleness filter on top of this same aggregation.
 */
export function standings(tournamentId: number): Standing[] {
  return toStandings(aggregateStandings(tournamentId));
}

/**
 * standings(), filtered for "The Field" panel on the tournament page: a
 * partial human player (someone who started but hasn't finished all boards)
 * who hasn't completed a board in over STANDINGS.ABANDON_TTL_S is presumed to
 * have abandoned the tournament and is left out entirely — this is a display
 * filter only: their board scores stay in the per-board matchpoint tables
 * aggregateStandings() builds, so they still fairly affect every other player
 * who played the same boards, exactly as duplicate scoring requires, and
 * standings() (stats.ts's source of truth) never sees this filter at all. If
 * a dropped player returns and finishes another board, they reappear
 * immediately (the check is a live function of their last completion, not a
 * stored flag). Benchmark AI personas ('kind' = 'ai') are exempt — they
 * always finish a tournament within about a minute of creation in the
 * common case (ai-players.ts), so a stalled house row would be a scheduler
 * bug worth surfacing, not something to quietly hide.
 */
export function visibleStandings(tournamentId: number): Standing[] {
  const now = Math.floor(Date.now() / 1000);
  const entries = aggregateStandings(tournamentId).filter(
    ({ agg }) =>
      agg.kind === 'ai' || agg.pcts.length >= BOARDS_PER_TOURNAMENT || now - agg.lastDoneAt <= STANDINGS.ABANDON_TTL_S,
  );
  return toStandings(entries);
}

/**
 * Provisional-rating threshold for the leaderboard (`/api/leaderboard` in
 * app.ts): players need this many rated tournaments (`elo_history` rows)
 * before they're eligible to show up in the ranked list. Below it a fresh
 * account still sits at or near ELO_INITIAL, which would otherwise rank it
 * above proven players whose results have pulled them under 1200 — the
 * classic cold-start problem with any pairwise rating. Doesn't touch the
 * rating math itself (still computed and stored from tournament 1), only
 * eligibility for display.
 */
export const PROVISIONAL_MIN_TOURNAMENTS = 4;

/**
 * DEMO=1 override for the quota above (an off-by-default knob — app.ts only
 * applies it when demo mode is enabled): the boot seeder (`demo-seed.ts`'s
 * DEFAULT_PROFILE) plays each bot through at most 2 tournaments, well under
 * the production quota, which would otherwise leave every preview's and the
 * permanent demo app's leaderboard permanently empty — contradicting the
 * seeder's own "leaderboard with rated players" ambient-data goal. A quota
 * of 1 still exercises the real provisional-gating code path (the
 * always-empty New Crosser persona stays excluded) without defeating the
 * point of demoing a populated leaderboard.
 */
export const DEMO_PROVISIONAL_MIN_TOURNAMENTS = 1;

/**
 * Human-only matchpoint averages — the Elo replay's input, DELIBERATELY not
 * the displayed standings(). House personas count in the displayed field but
 * are unrated, and they must not shape human ratings even indirectly:
 * matchpoint averages are not order-preserving under field insertion, so
 * letting house scores into the pcts could flip which of two humans "beat"
 * the other in a pairwise Elo update. Ratings stay a pure human-vs-human
 * measure — which also insulates the whole Elo history from future
 * difficulty-tier recalibration (a retuned tier retroactively moves house
 * scores, and with them the displayed pcts, but never anyone's rating).
 */
function eloParticipants(tournamentId: number): { userId: number; totalPct: number }[] {
  const rows = (
    stmtDoneBoards.all(tournamentId) as (BoardRow & { user_kind: 'human' | 'ai' })[]
  ).filter((r) => r.user_kind === 'human');
  const pcts = new Map<number, number[]>();
  for (let no = 1; no <= BOARDS_PER_TOURNAMENT; no++) {
    const boardRows = rows.filter((r) => r.board_no === no);
    const mps = matchpoints(boardRows.map((r) => r.score_ns ?? 0));
    boardRows.forEach((r, i) => pcts.set(r.user_id, [...(pcts.get(r.user_id) ?? []), mps[i].pct]));
  }
  return [...pcts.entries()]
    .filter(([, p]) => p.length >= BOARDS_PER_TOURNAMENT)
    .map(([userId, p]) => ({ userId, totalPct: avg(p) ?? 0 }));
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
    // eloParticipants, not standings(): benchmark AI personas never rate, and
    // the replay's pcts are matchpointed among humans only so house scores
    // can't shape a human's rating even indirectly (see its doc comment).
    // Persona board completions don't trigger this replay (game.ts skips
    // them) — correct precisely because their rows can't change these inputs.
    const complete = eloParticipants(id);
    if (complete.length < 2) continue;
    const participants = complete.map((s) => ({
      userId: s.userId,
      rating: ratings.get(s.userId) ?? ELO_INITIAL,
      totalPct: s.totalPct,
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
  difficulty: Difficulty,
  opts: { nowSec?: number; rng?: () => number } = {},
): { tournament: TournamentRow; nextBoard: number } {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const rng = opts.rng ?? Math.random;
  let t = stmtMyUnfinished.get(userId, userId, BOARDS_PER_TOURNAMENT) as TournamentRow | undefined;
  if (!t) {
    const candidates = stmtCandidates.all(
      nowSec - PLACEMENT.BACKLOG_WINDOW_S,
      userId,
      difficulty,
    ) as PlacementCandidate[];
    t = chooseTournament(candidates, nowSec, rng) ?? undefined;
  }
  if (!t) {
    const schedule = JSON.stringify(Array(BOARDS_PER_TOURNAMENT).fill(difficulty));
    t = stmtCreateTournament.get(
      'Tournament',
      randomBytes(16).toString('hex'),
      difficulty,
      schedule,
    ) as TournamentRow;
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
  const done = stmtDoneBoards.all(tournamentId) as (BoardRow & { user_handle: string; user_kind: string })[];
  return mine.map((b) => {
    if (b.state !== 'done') return { no: b.board_no, state: b.state, contractLabel: null, scoreNS: null, pct: null };
    // The full field, exactly like standings()/boardResult(): benchmark AI
    // scores count in the viewer's pct — the house are real pairs.
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
