import { db, BOARDS_PER_TOURNAMENT } from './db.js';
import { PROVISIONAL_MIN_TOURNAMENTS, standings } from './tournaments.js';

/**
 * The activity feed ("TRAFFIC") — who else has been on the bridge lately.
 *
 * Two properties of the data model shape everything here, and both are worth
 * understanding before editing:
 *
 * 1. THE SERVER IS TIMEZONE-BLIND. Every timestamp in the database is UTC unix
 *    seconds and no user's timezone is stored anywhere. The feed groups by
 *    calendar day and by morning/afternoon/evening in the VIEWER's local time,
 *    so that bucketing cannot happen here — this module emits raw, atomic
 *    events at per-board grain and web/src/pages/activityFeed.ts does all the
 *    grouping in the browser. That is a deliberate divergence from stats.ts's
 *    dailyBoards/DayGrid, which bucket UTC days server-side because a
 *    punch-card of your own history is a different question from "was anyone
 *    around this evening".
 *
 * 2. elo_history CARRIES NO TIMESTAMP. It is wiped and replayed in
 *    tournament-id order on every board completion (recomputeElo), so a rating
 *    row has no instant of its own. The only honest bridge to wall-clock is
 *    the one stats.ts's stmtEloSeries already uses: stamp the rating event
 *    with the player's LAST COMPLETED BOARD of that tournament. A delta
 *    therefore lands at the end of a crossing, and an old tournament finishing
 *    today can restate a number shown yesterday. That is accepted and
 *    disclosed in the UI footer rather than engineered around — snapshotting
 *    deltas into their own table would fight the evergreen-Elo model.
 *
 * Two filters apply to every query below and neither is optional:
 * `users.kind = 'human'` (the benchmark house personas play constantly and
 * would drown the feed — see ai-players.ts) and `tournaments.kind = 'standard'`
 * (demo-mode exhibits must never appear; inert in production).
 */

/** A player referenced by at least one event, so the client needn't join. */
export interface ActivityPlayer {
  handle: string;
  picture: string | null;
}

export type ActivityEvent =
  /** One completed board. The grain the client needs to bucket by local hour. */
  | { kind: 'board'; userId: number; at: number }
  /** An account appeared (and has picked a handle). */
  | { kind: 'joined'; userId: number; at: number }
  /** All four boards of a standard tournament finished. */
  | {
      kind: 'crossing';
      userId: number;
      at: number;
      tournamentId: number;
      tournamentName: string;
      pct: number;
      rank: number;
      /** complete players in that field, the denominator `rank` is out of */
      of: number;
      /** null when the tournament rated nobody (< 2 human finishers) — never 0 */
      eloDelta: number | null;
    }
  | {
      kind: 'milestone';
      userId: number;
      at: number;
      milestone: 'first-crossing' | 'entered-ladder' | 'peak-rating';
      /** the new rating, on 'peak-rating' only */
      value?: number;
    };

export interface ActivityPayload {
  /** window start, unix seconds — the client trims to its own last 7 local days */
  since: number;
  /** keyed by user id (stringified by JSON) */
  players: Record<number, ActivityPlayer>;
  events: ActivityEvent[];
}

// Completed boards across all human players in the window. This is the one
// query in the codebase that starts from a time window and spans every user,
// which is why db.ts carries idx_boards_updated for it.
const stmtWindowBoards = db.prepare(
  `SELECT b.user_id, b.updated_at
     FROM boards b
     JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
     JOIN users u ON u.id = b.user_id AND u.kind = 'human' AND u.handle IS NOT NULL
    WHERE b.state = 'done' AND b.updated_at >= ?
    ORDER BY b.updated_at`,
);

// Which human players finished a whole tournament in the window. The inner
// GROUP BY is pre-filtered to tournaments touched in the window so it never
// aggregates the entire boards table just to throw the old rows away.
//
// LEFT JOIN on elo_history because a tournament with fewer than 2 human
// finishers rates nobody: `before`/`after` come back NULL there and the feed
// prints an em dash, never a 0.
const stmtWindowCrossings = db.prepare(
  `SELECT f.user_id, f.tournament_id, f.finished_at, t.name AS tournament_name, h.before, h.after
     FROM (
       SELECT b.user_id, b.tournament_id, MAX(b.updated_at) AS finished_at, COUNT(*) AS done
         FROM boards b
        WHERE b.state = 'done'
          AND b.tournament_id IN (SELECT DISTINCT tournament_id FROM boards WHERE updated_at >= ?)
        GROUP BY b.user_id, b.tournament_id
     ) f
     JOIN tournaments t ON t.id = f.tournament_id AND t.kind = 'standard'
     JOIN users u ON u.id = f.user_id AND u.kind = 'human' AND u.handle IS NOT NULL
     LEFT JOIN elo_history h ON h.user_id = f.user_id AND h.tournament_id = f.tournament_id
    WHERE f.done = ? AND f.finished_at >= ?`,
);

// New accounts. Gated on `handle IS NOT NULL` for the same reason every other
// player-facing query is: an account that never got through the handle picker
// has no name to print.
const stmtWindowJoins = db.prepare(
  `SELECT id AS user_id, created_at
     FROM users
    WHERE kind = 'human' AND handle IS NOT NULL AND created_at >= ?`,
);

// Every crossing a player has EVER completed — needed unwindowed, because
// "this was their first" is a claim about all of history, not about the week.
const stmtAllCrossings = db.prepare(
  `SELECT b.tournament_id, MAX(b.updated_at) AS finished_at, COUNT(*) AS done
     FROM boards b
     JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
    WHERE b.state = 'done' AND b.user_id = ?
    GROUP BY b.tournament_id
   HAVING done = ?`,
);

// tournament_id IS the rating timeline (see the header note), so this ordering
// is the rating sequence — never order elo_history by id or by finished_at.
const stmtEloSeries = db.prepare(
  `SELECT tournament_id, before, after FROM elo_history WHERE user_id = ? ORDER BY tournament_id`,
);

const stmtPlayers = db.prepare(`SELECT id, handle, picture FROM users WHERE id = ?`);

interface CrossingRow {
  user_id: number;
  tournament_id: number;
  finished_at: number;
  tournament_name: string;
  before: number | null;
  after: number | null;
}

/**
 * Milestones for one player, derived from their own history — nothing here
 * needs another player's data.
 *
 * "Passed X on the ladder" is deliberately NOT among these. It would need the
 * ladder's running order reconstructed at two points in time, and under
 * wipe-and-replay that ordering is not stable: the same recompute that can
 * restate a delta can also reorder the pair. A milestone that quietly stops
 * being true is worse than no milestone.
 */
function milestonesFor(userId: number, sinceUnix: number): ActivityEvent[] {
  const crossings = stmtAllCrossings.all(userId, BOARDS_PER_TOURNAMENT) as {
    tournament_id: number;
    finished_at: number;
  }[];
  if (!crossings.length) return [];
  const finishedAt = new Map(crossings.map((c) => [c.tournament_id, c.finished_at]));
  const out: ActivityEvent[] = [];

  // First crossing ever — by wall-clock, which is what a feed means by "first".
  const first = crossings.reduce((a, b) => (b.finished_at < a.finished_at ? b : a));
  if (first.finished_at >= sinceUnix) {
    out.push({ kind: 'milestone', userId, at: first.finished_at, milestone: 'first-crossing' });
  }

  const series = stmtEloSeries.all(userId) as { tournament_id: number; before: number; after: number }[];

  // The crossing that took them over the provisional quota and onto the ladder.
  const ladder = series[PROVISIONAL_MIN_TOURNAMENTS - 1];
  const ladderAt = ladder ? finishedAt.get(ladder.tournament_id) : undefined;
  if (ladderAt !== undefined && ladderAt >= sinceUnix) {
    out.push({ kind: 'milestone', userId, at: ladderAt, milestone: 'entered-ladder' });
  }

  // A new personal best. The first rated crossing is skipped on purpose — it
  // is trivially a peak, and announcing it says nothing.
  let best = -Infinity;
  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    if (i > 0 && row.after > best) {
      const at = finishedAt.get(row.tournament_id);
      if (at !== undefined && at >= sinceUnix) {
        out.push({ kind: 'milestone', userId, at, milestone: 'peak-rating', value: row.after });
      }
    }
    best = Math.max(best, row.after);
  }
  return out;
}

/**
 * Everything that happened on the bridge since `sinceUnix`, as flat events.
 *
 * Deliberately unsorted beyond each query's own order and deliberately
 * ungrouped: the client owns both, because both depend on a timezone this
 * process does not have.
 */
export function recentActivity(sinceUnix: number): ActivityPayload {
  const events: ActivityEvent[] = [];
  const userIds = new Set<number>();

  for (const b of stmtWindowBoards.all(sinceUnix) as { user_id: number; updated_at: number }[]) {
    events.push({ kind: 'board', userId: b.user_id, at: b.updated_at });
    userIds.add(b.user_id);
  }

  for (const j of stmtWindowJoins.all(sinceUnix) as { user_id: number; created_at: number }[]) {
    events.push({ kind: 'joined', userId: j.user_id, at: j.created_at });
    userIds.add(j.user_id);
  }

  const crossings = stmtWindowCrossings.all(sinceUnix, BOARDS_PER_TOURNAMENT, sinceUnix) as CrossingRow[];

  // standings() is the displayed field — house personas included, exactly as
  // they are in everyone's matchpoints — so the percentage here is the same
  // number the player saw on their own result screen. (eloParticipants() is
  // the human-only one, and it is not what this should report.)
  const fields = new Map<number, ReturnType<typeof standings>>();
  const fieldFor = (tournamentId: number) => {
    let f = fields.get(tournamentId);
    if (!f) {
      f = standings(tournamentId);
      fields.set(tournamentId, f);
    }
    return f;
  };

  for (const c of crossings) {
    const field = fieldFor(c.tournament_id);
    const mine = field.find((s) => s.userId === c.user_id);
    // rank is only assigned to complete players, so `of` counts those.
    const of = field.filter((s) => s.complete).length;
    if (!mine || mine.rank === undefined || mine.totalPct === null) continue;
    events.push({
      kind: 'crossing',
      userId: c.user_id,
      at: c.finished_at,
      tournamentId: c.tournament_id,
      tournamentName: c.tournament_name,
      pct: mine.totalPct,
      rank: mine.rank,
      of,
      eloDelta: c.before === null || c.after === null ? null : c.after - c.before,
    });
    userIds.add(c.user_id);
  }

  // Milestones hang off crossings, so only players who finished something in
  // the window can have earned one.
  for (const userId of new Set(crossings.map((c) => c.user_id))) {
    events.push(...milestonesFor(userId, sinceUnix));
  }

  const players: Record<number, ActivityPlayer> = {};
  for (const id of userIds) {
    const row = stmtPlayers.get(id) as { id: number; handle: string | null; picture: string | null } | undefined;
    if (row?.handle) players[id] = { handle: row.handle, picture: row.picture };
  }

  // A player with no handle has no name to print; drop anything referencing one
  // rather than leaking a blank row.
  return { since: sinceUnix, players, events: events.filter((e) => players[e.userId]) };
}
