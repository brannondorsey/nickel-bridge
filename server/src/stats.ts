import {
  BidCategory,
  Call,
  Contract,
  ConventionFamily,
  ELO_INITIAL,
  Seat,
  Strain,
  bidCategory,
  boardConditions,
  conventionFamily,
  explainBid,
} from '@bridge/core';
import { db } from './db.js';
import { StandingDetail, standings } from './tournaments.js';

const stmtUser = db.prepare(
  `SELECT id, handle, picture, elo, created_at, kind FROM users WHERE id = ? AND handle IS NOT NULL`,
);
const stmtProfileKind = db.prepare(`SELECT kind FROM users WHERE id = ? AND handle IS NOT NULL`);

/**
 * Whose profile is this — a person's, the house's, or nobody's?
 *
 * Split out from playerStats because app.ts has to answer "may this caller see
 * it?" BEFORE building it. The house personas' profiles are public (they're
 * calibration content, not anyone's record) and everyone else's needs a
 * session, and running the full stats build first would let an anonymous
 * id-walk drive that whole query pile for every id it tries, 401 or not.
 */
export function profileKind(userId: number): 'human' | 'ai' | null {
  const row = stmtProfileKind.get(userId) as { kind: 'human' | 'ai' } | undefined;
  return row?.kind ?? null;
}
// elo_history is wiped and replayed in tournament-id order on every recompute,
// so its rows carry no timestamp of their own: before/after are positions in
// that replay chain, and finished_at (this user's last completed board of the
// tournament) is the only wall clock their rating history has. Both are read
// because eloProgression() needs the chain for each crossing's delta and the
// clock to lay those deltas out in play order — see its doc comment. The ORDER
// BY is the chain's, and must stay so: the deltas are only well-defined read in
// that sequence, and eloProgression() re-sorts a copy for display.
const stmtEloSeries = db.prepare(
  `SELECT h.tournament_id, h.before, h.after, t.name AS tournament_name,
          (SELECT MAX(b.updated_at) FROM boards b
            WHERE b.tournament_id = h.tournament_id AND b.user_id = h.user_id AND b.state = 'done') AS finished_at
   FROM elo_history h JOIN tournaments t ON t.id = h.tournament_id
   WHERE h.user_id = ? ORDER BY h.tournament_id`,
);
// Every board/tournament sweep here excludes demo-mode exhibits
// (tournaments.kind = 'exhibit'): a scenario board someone jumped into must
// not inflate boardsCompleted, chart series, or anyone's percentile pool.
// Inert in production, where every tournament is 'standard'.
const stmtDoneBoards = db.prepare(
  `SELECT b.tournament_id, b.board_no, b.calls, b.bid_evals, b.contract, b.tricks_declarer, b.updated_at,
          t.name AS tournament_name
   FROM boards b JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.user_id = ? AND b.state = 'done' ORDER BY b.updated_at, b.id`,
);
const stmtRatedElos = db.prepare(
  `SELECT elo FROM users WHERE EXISTS (SELECT 1 FROM elo_history h WHERE h.user_id = users.id)`,
);
// No users.kind filter: the benchmark AI personas (ai-players.ts) are full
// field members — their bid evals belong in the accuracy pool and the
// activePlayers count, same as their scores in everyone's matchpoints.
const stmtAllDoneEvals = db.prepare(
  `SELECT b.user_id, b.bid_evals FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.state = 'done'`,
);
const stmtAllTournamentIds = db.prepare(`SELECT id FROM tournaments WHERE kind = 'standard' ORDER BY id`);
// Contracts across every user, for the "Declaring" percentile row — same
// declaring-side filter (contract.declarer % 2 === 0) applies to every row
// regardless of whose board it is, since every player always sits South.
const stmtAllDoneContracts = db.prepare(
  `SELECT b.user_id, b.contract, b.tricks_declarer FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.state = 'done' AND b.contract IS NOT NULL`,
);

const RIVAL_TOP_N = 10;

/** head-to-head summary against one other player who has shared a field with this user. */
export interface Rival {
  userId: number;
  handle: string;
  kind: 'human' | 'ai';
  /** tournaments where both players have >=1 scored board (see rivalries()'s doc comment) */
  shared: number;
  record: { ahead: number; behind: number; tied: number };
  /**
   * This rival's completed-board count, so the profile's RIVALRIES panel knows
   * whether a Compare link would land on a real comparison or on the "not
   * enough boards yet" state. Bounded by RIVAL_TOP_N, so at most ten extra
   * COUNTs per profile load.
   */
  boards: number;
}

/**
 * One tournament's worth of one chart series.
 *
 * Every series below (`eloSeries`, `pctSeries`, `accuracySeries`) is ordered by
 * `finishedAt` ascending — when THIS player last completed a board of that
 * tournament — never by tournament id. Tournaments never close (see
 * tournaments.ts), so ids are the order the app minted the deals, not the order
 * anyone played them: a player can be placed into a months-old tournament today,
 * or resume one they abandoned in the spring. Ordered by id, that crossing draws
 * to the LEFT of tournaments finished weeks later, and the charts' x axis stops
 * being time — a rise between two adjacent points would no longer mean the
 * player improved, only that the deals happened to be numbered that way.
 */
export interface StatPoint {
  tournamentId: number;
  tournamentName: string;
  finishedAt: number | null;
}

/**
 * Exported because compare.ts is a pure function of two of these — everything
 * its error models need (the grade histogram, the per-crossing pct series, and
 * every rate's own numerator and denominator) is already collected here.
 */
export interface PlayerStats {
  /** kind = 'ai' identifies one of the benchmark house personas (ai-players.ts) */
  user: { id: number; handle: string; picture: string | null; elo: number; createdAt: number; kind: 'human' | 'ai' };
  totals: {
    boardsCompleted: number;
    tournamentsPlayed: number;
    tournamentsCompleted: number;
    /** longest run of consecutive UTC calendar days with >=1 completed board, from `dailyBoards` */
    streakDays: number;
    currentElo: number;
    peakElo: number;
    avgPct: number | null;
    /** the player's best single-tournament score, from pctSeries; null if pctSeries is empty */
    bestPct: { pct: number; tournamentName: string; tournamentId: number } | null;
    /**
     * Boards taken outright: full matchpoints, i.e. this player outscored
     * EVERY other pair who has played that deal (the 'top' of duplicate
     * bridge — see the glossary term). Counted from the per-board pcts
     * standings() already computes (`boardPcts`), so it costs no extra
     * matchpointing; `pct === 100` is the honest test, since matchpoints()
     * splits a tie (two pairs with the same score each get 50 in a two-pair
     * field) and hands a lone finisher 50 rather than a free top.
     *
     * The natural denominator is `boardsCompleted` — the boards swept here are
     * exactly the boards counted there, so no separate total is carried.
     */
    tops: {
      count: number;
      /** most recent one by completion time, for a deep link; null when count === 0 */
      latest: { tournamentId: number; boardNo: number } | null;
    };
    avgBidAccuracy: number | null;
    gradeCounts: { excellent: number; good: number; fair: number; poor: number };
    declarer: { boards: number; made: number };
    defense: { boards: number; beat: number };
    passedOut: number;
    /** rating change since the start of the current UTC month; null when unrated */
    monthlyEloDelta: number | null;
  };
  /**
   * Signed histogram of tricks made vs. contract, declaring boards only (same
   * "user's side declared" filter as totals.declarer). delta = tricks_declarer
   * - (6 + contract.level); buckets clip at ±3 ("3+ down"/"3+ over") so one
   * blown slam can't stretch the row scale. avgDelta is the *unclamped* mean
   * across those boards — a true trick-differential figure even though the
   * display buckets saturate. boards === totals.declarer.boards always; kept
   * as its own field so the client doesn't have to cross-reference totals.
   */
  trickDelta: {
    buckets: { delta: -3 | -2 | -1 | 0 | 1 | 2 | 3; count: number }[]; // fixed order, always 7 entries
    boards: number;
    avgDelta: number | null; // null only when boards === 0
  };
  /** "better than N% of players" per metric; null when the player or field lacks data */
  percentiles: {
    elo: number | null;
    avgPct: number | null;
    bidAccuracy: number | null;
    /** declaring-side make-rate percentile — the one new row this batch adds, see stats-page blueprint §4 */
    declaring: number | null;
    ratedPlayers: number;
    activePlayers: number;
    /** size of the declaring-rate comparison pool (players with at least one declaring board) */
    declaringPlayers: number;
  };
  /** rating after each crossing, in play order — see eloProgression() */
  eloSeries: (StatPoint & { elo: number })[];
  pctSeries: (StatPoint & { pct: number; boards: number; fieldSize: number })[];
  accuracySeries: (StatPoint & { accuracy: number | null; calls: number })[];
  /**
   * The player's graded calls bucketed by auction role (see core's
   * bidCategory), ranked best to worst by share of satisfactory-or-better
   * (2+ star, i.e. 'good'/'excellent') calls. Derived entirely from the
   * stored auction + bid_evals — historical boards count the same as new
   * ones. Only buckets the player has actually visited appear.
   */
  bidTypes: { category: BidCategory; total: number; satisfactory: number }[];
  /**
   * The subset of graded calls that were a named SAYC convention (Stayman,
   * Jacoby transfer, Blackwood, Gerber, weak two, negative double, Michaels
   * — see core's conventionFamily), bucketed by which one. A second view
   * onto the same bid_evals as `bidTypes`, along a different axis (named
   * convention, not auction role) — natural bids never appear here. Ranked
   * the same way as bidTypes (best to worst by satisfactory share); only
   * conventions the player has actually called appear.
   */
  conventions: { family: ConventionFamily; total: number; satisfactory: number }[];
  /**
   * Declaring-side contracts only (same population as `totals.declarer`, i.e.
   * boards where contract.declarer is on the human's side, N-S), bucketed two
   * ways: partscore/game/slam tier (contractTier — level 6-7 is always slam;
   * otherwise game at 3NT/4-of-a-major/5-of-a-minor and up, partscore below
   * that) and doubled-or-redoubled (contract.doubled || contract.redoubled
   * collapsed into one bucket — the auction state machine makes the two
   * booleans mutually exclusive, see auction.ts, and redoubled contracts are
   * rare enough on their own that a separate row would mostly read 0/0).
   * `strains` is a pure distribution (not a make-rate) of the same declaring
   * boards by strain family — its three counts sum to `totals.declarer.boards`.
   */
  contractMix: {
    partscore: { boards: number; made: number };
    game: { boards: number; made: number };
    slam: { boards: number; made: number };
    doubled: { boards: number; made: number };
    strains: { notrump: number; major: number; minor: number };
  };
  /**
   * Completed boards bucketed by UTC calendar day (the day `updated_at` last
   * flipped to `state = 'done'` — `stmtDoneBoards` already filters on that
   * state, so this is "the day the board was finished," not started), sparse
   * — only days with at least one board appear — ordered ascending by date.
   * Deliberately NOT named "crossings": that word already means a whole
   * tournament elsewhere in the app (Lobby's TOLLS PAID list, the CROSSINGS
   * tab); a single board is a "toll" (see ScoreReceipt's "THE TOLL — BOARD
   * N"), so this field's UI-facing copy says "tolls," not "crossings."
   */
  dailyBoards: { date: string; count: number }[];
  /** other players ranked by shared-tournament count, most-crossed-paths first (max RIVAL_TOP_N) */
  rivals: Rival[];
}

interface EvalRow {
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  score: number;
}

interface DoneBoardRow {
  tournament_id: number;
  board_no: number;
  calls: string;
  bid_evals: string;
  contract: string | null;
  tricks_declarer: number | null;
  updated_at: number;
  tournament_name: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Standard partscore/game/slam boundary. Level 6-7 is always slam regardless
 * of strain (a slam already implies game); otherwise it's game once the
 * trick score alone would hit 100 — 3NT, 4-of-a-major, or 5-of-a-minor and up
 * (see packages/core/src/score.ts's game-bonus threshold) — partscore below
 * that.
 */
function contractTier(level: number, strain: Strain): 'partscore' | 'game' | 'slam' {
  if (level >= 6) return 'slam';
  const gameLevel = strain === 4 ? 3 : strain === 2 || strain === 3 ? 4 : 5; // NT / major / minor
  return level >= gameLevel ? 'game' : 'partscore';
}

/** Notrump vs. major (♥♠) vs. minor (♣♦) — for the declarer-side strain split. */
function strainFamily(strain: Strain): 'notrump' | 'major' | 'minor' {
  if (strain === 4) return 'notrump';
  return strain === 2 || strain === 3 ? 'major' : 'minor';
}

/** The human always bids from South (game.ts's HUMAN_SEAT). */
const HUMAN_SEAT: Seat = 2;

/**
 * One playerStats() request touches standings() for the same tournament from
 * up to three places — this profile's own pctSeries, rivalries() (same
 * tournament set as pctSeries), and fieldPercentiles()'s site-wide sweep
 * (which includes every tournament the other two touch, plus everyone
 * else's). Without sharing, an active player's own tournaments get
 * matchpointed two or three times over on every single profile load. A
 * request-scoped memoization closure — passed explicitly into rivalries()
 * and fieldPercentiles() rather than a module-level cache — keeps each
 * tournament's standings() call to once per request while staying free of
 * any cross-request staleness concern (a fresh closure, and thus a fresh
 * cache, is created at the top of every playerStats() call).
 */
export function memoizedStandings(): (tournamentId: number) => StandingDetail[] {
  const cache = new Map<number, StandingDetail[]>();
  return (tournamentId: number) => {
    let s = cache.get(tournamentId);
    if (!s) {
      s = standings(tournamentId);
      cache.set(tournamentId, s);
    }
    return s;
  };
}

/**
 * Head-to-head record against everyone who has shared a completed field with
 * this user, ranked by how often paths crossed (not by who's winning) and
 * capped to the top RIVAL_TOP_N. "Shared" = a standard tournament where BOTH
 * this user and the other player have a standings() row with totalPct !==
 * null — i.e. at least one scored board each, matching standings()'s own
 * inclusion rule. Deliberately NOT gated on `complete` (all 4 boards done):
 * requiring completeness would silently drop rivalries formed in tournaments
 * either side is still mid-way through, which is most of them in an evergreen
 * app where tournaments never close.
 *
 * ahead/behind/tied compares totalPct DIRECTLY, not standings()'s `rank`
 * field: rank is only assigned to players who have completed every board
 * (`s.complete`), so two players who've each played a handful of boards in a
 * still-open tournament would both lack a rank and silently drop out of the
 * tally if this used rank instead. totalPct is populated the moment either
 * side has scored even one board, so it's the only field that gives every
 * shared tournament a comparison. Comparing the rounded (1-decimal) totalPct
 * — the same value the standings/percentage panels already display — means a
 * "tied" result here always matches what a user would see printed side by
 * side.
 *
 * Cost: one standings() lookup per tournament in `tournamentIds` (bounded by
 * this user's own played-tournament count), via the request-scoped
 * `getStandings` cache — so a tournament already matchpointed for pctSeries
 * or about to be swept by fieldPercentiles() isn't recomputed here.
 */
function rivalries(userId: number, tournamentIds: number[], getStandings: (id: number) => StandingDetail[]): Rival[] {
  const tally = new Map<
    number,
    { handle: string; kind: 'human' | 'ai'; shared: number; ahead: number; behind: number; tied: number }
  >();
  for (const tid of tournamentIds) {
    const field = getStandings(tid);
    const mine = field.find((s) => s.userId === userId);
    if (!mine || mine.totalPct === null) continue;
    for (const s of field) {
      if (s.userId === userId || s.totalPct === null) continue;
      const r = tally.get(s.userId) ?? { handle: s.handle, kind: s.kind, shared: 0, ahead: 0, behind: 0, tied: 0 };
      r.handle = s.handle; // latest handle wins, same as any other join-on-userId display
      r.kind = s.kind;
      r.shared++;
      if (mine.totalPct > s.totalPct) r.ahead++;
      else if (mine.totalPct < s.totalPct) r.behind++;
      else r.tied++;
      tally.set(s.userId, r);
    }
  }
  return [...tally.entries()]
    .map(([rivalUserId, r]) => ({
      userId: rivalUserId,
      handle: r.handle,
      kind: r.kind,
      shared: r.shared,
      record: { ahead: r.ahead, behind: r.behind, tied: r.tied },
    }))
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.record.ahead - b.record.behind - (a.record.ahead - a.record.behind) ||
        a.handle.localeCompare(b.handle),
    )
    .slice(0, RIVAL_TOP_N)
    // After the slice, so this is at most RIVAL_TOP_N counts rather than one
    // per opponent the user has ever met.
    .map((r) => ({ ...r, boards: completedBoardCount(r.userId) }));
}

/**
 * Standard tournaments where BOTH players have at least one completed board,
 * oldest first. Ordering by tournament id (not a timestamp) matches the Elo
 * replay's notion of "the rating timeline" — see recomputeElo — so the tally
 * strip reads in the same order the ratings moved.
 */
const stmtSharedTournaments = db.prepare(
  `SELECT DISTINCT b.tournament_id AS id FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.user_id = ? AND b.state = 'done'
     AND EXISTS (SELECT 1 FROM boards o
                 WHERE o.tournament_id = b.tournament_id AND o.user_id = ? AND o.state = 'done')
   ORDER BY b.tournament_id`,
);

const stmtCompletedBoards = db.prepare(
  `SELECT COUNT(*) AS n FROM boards b
   JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
   WHERE b.user_id = ? AND b.state = 'done'`,
);

/** Just enough of a user to name them on a screen that isn't their profile. */
export function playerIdentity(
  userId: number,
): { id: number; handle: string; picture: string | null; kind: 'human' | 'ai' } | null {
  const u = stmtUser.get(userId) as
    | { id: number; handle: string; picture: string | null; kind: 'human' | 'ai' }
    | undefined;
  return u ? { id: u.id, handle: u.handle, picture: u.picture, kind: u.kind } : null;
}

/**
 * Completed standard boards, as one cheap COUNT.
 *
 * Compare needs this BEFORE deciding whether to build anything: the full
 * profile build is the most expensive read in the app, and a pair that is too
 * thin to compare must not be able to trigger two of them.
 */
export function completedBoardCount(userId: number): number {
  return (stmtCompletedBoards.get(userId) as { n: number }).n;
}

/** Every persona row, as a pure read — `ensureAiPlayers()` writes and must not be used here. */
const stmtHousePlayers = db.prepare(
  `SELECT id, handle FROM users WHERE kind = 'ai' AND handle IS NOT NULL ORDER BY id`,
);

/** How many shared crossings the tally strip draws. Older ones still count in the record. */
const SEQUENCE_MAX = 12;

/** Head-to-head between one specific pair. */
export interface PairRecord {
  shared: number;
  ahead: number;
  behind: number;
  tied: number;
  /**
   * One entry per shared crossing, oldest first, capped to the most recent
   * SEQUENCE_MAX — `ahead`/`behind`/`tied` above always count every crossing,
   * so the strip is a window on the record, never the record itself.
   */
  sequence: ('you' | 'them' | 'level')[];
}

/**
 * The record between two named players.
 *
 * Deliberately NOT read off `rivalries()`: that caps at RIVAL_TOP_N and sorts by
 * how often paths crossed, so the very player being asked about can be missing
 * from it. It also returns only the aggregate, and the tally strip needs the
 * per-crossing sequence.
 *
 * Comparison rules match rivalries() exactly — `totalPct` rather than `rank`,
 * because rank is only assigned once a player has completed all four boards, so
 * two people mid-way through a shared tournament would both lack one and drop
 * silently out of the tally. Comparing the rounded totalPct means a "level"
 * here always agrees with the two figures printed side by side.
 */
export function pairRecord(
  userId: number,
  otherId: number,
  getStandings: (id: number) => StandingDetail[],
): PairRecord {
  const rec: PairRecord = { shared: 0, ahead: 0, behind: 0, tied: 0, sequence: [] };
  const ids = stmtSharedTournaments.all(userId, otherId) as { id: number }[];
  for (const { id } of ids) {
    const field = getStandings(id);
    const mine = field.find((s) => s.userId === userId);
    const theirs = field.find((s) => s.userId === otherId);
    if (!mine || !theirs || mine.totalPct === null || theirs.totalPct === null) continue;
    rec.shared++;
    const outcome = mine.totalPct > theirs.totalPct ? 'you' : mine.totalPct < theirs.totalPct ? 'them' : 'level';
    if (outcome === 'you') rec.ahead++;
    else if (outcome === 'them') rec.behind++;
    else rec.tied++;
    rec.sequence.push(outcome);
  }
  rec.sequence = rec.sequence.slice(-SEQUENCE_MAX);
  return rec;
}

/** One house persona's record against each of the two players being compared. */
export interface CommonGroundRow {
  userId: number;
  handle: string;
  you: PairRecord;
  them: PairRecord;
}

/**
 * The stand-in for head-to-head when two players have never met.
 *
 * The house personas are the only fixed reference this app has: they play every
 * `ai_field` tournament at a constant tier, so "how often did you finish ahead
 * of The Shark" is a field-controlled question both players have answered
 * independently. That is a genuinely weaker inference than meeting someone —
 * hence it is displayed without a verdict — but it is the nearest thing to a
 * shared table.
 *
 * Note this had to be a RECORD against each persona rather than "your average
 * on boards where that persona was in the field": all three personas join every
 * ai_field tournament, so those three board sets are identical and the three
 * rows would have printed the same number.
 */
export function commonGround(
  aId: number,
  bId: number,
  getStandings: (id: number) => StandingDetail[],
): CommonGroundRow[] {
  const house = (stmtHousePlayers.all() as { id: number; handle: string }[])
    // Never either of the two being compared. Comparing against a house
    // persona is reachable from the UI — their profiles are public and their
    // board counts clear any floor — and without this that persona appears in
    // its own common-ground panel as `pairRecord(them, them)`: a record against
    // itself, every crossing "level".
    .filter((h) => h.id !== aId && h.id !== bId);
  return house
    .map((h) => ({ userId: h.id, handle: h.handle, you: pairRecord(aId, h.id, getStandings), them: pairRecord(bId, h.id, getStandings) }))
    // BOTH, not either. A persona only one side has faced is not common
    // ground, and rendering it prints "0 of 0" beside a real record — which
    // reads as a player who lost every crossing rather than one who never
    // played, the exact misreading this screen exists to prevent.
    .filter((r) => r.you.shared > 0 && r.them.shared > 0);
}

/** share of *other* players this value beats, 0..100; null without a comparison field */
function betterThan(value: number, field: number[]): number | null {
  if (field.length < 2) return null;
  const below = field.filter((v) => v < value).length;
  return Math.round((below / (field.length - 1)) * 100);
}

/**
 * Longest run of consecutive UTC calendar days in `dates` (already sorted
 * ascending, one entry per day with >=1 completed board — see `dailyBoards`).
 * Parsing each 'YYYY-MM-DD' as UTC midnight and diffing in days (rather than
 * string-comparing) keeps month/year boundaries correct.
 */
function longestDayStreak(dates: string[]): number {
  if (!dates.length) return 0;
  let best = 1;
  let current = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
    const curr = new Date(`${dates[i]}T00:00:00Z`).getTime();
    current = curr - prev === 86_400_000 ? current + 1 : 1;
    best = Math.max(best, current);
  }
  return best;
}

interface EloRow {
  tournament_id: number;
  tournament_name: string;
  before: number;
  after: number;
  finished_at: number | null;
}

/**
 * The rating line, laid out in the order this player actually finished their
 * crossings rather than in the order `recomputeElo` replays them.
 *
 * The two orders are not the same, and the gap is the whole reason this function
 * exists. `recomputeElo` wipes and replays every tournament in tournament-id
 * order, so `after` is a running total over THAT sequence — but tournaments
 * never close, so a player can finish a months-old, low-id tournament today.
 * Read straight off the table, that crossing lands at the far left of the chart,
 * to the left of tournaments finished weeks before it. (activity.ts's
 * 'entered-rankings' milestone splits the same two orders apart for the same
 * reason, and says so at length.)
 *
 * Sorting the rows by `finished_at` alone would fix the axis and break the
 * values. `after` means "the rating once every crossing with a lower id has been
 * replayed", so the last row BY DATE carries a rating that omits every
 * higher-id crossing — in exactly the backfill case above, that is not the
 * player's rating today, and the endpoint dot would disagree with the rating
 * printed directly above the chart.
 *
 * So the DELTAS travel and the totals are rebuilt: each crossing contributes
 * `after - before` (what it was worth in today's replay) and they accumulate
 * from ELO_INITIAL in play order. Both ends stay honest — the line starts at
 * 1200, and because a sum doesn't care about order and this player's chain is
 * unbroken (the first row's `before` is ELO_INITIAL and each later `before` is
 * the previous `after`), it ends at exactly `users.elo`. The line is a
 * reconstruction either way — which the chart already discloses, since any
 * scored board can restate the whole thing — but this one reconstructs the
 * player's own history instead of the replay's bookkeeping.
 *
 * For a player whose play order matches id order it returns the raw chain
 * unchanged, which is most players: placement serves recent tournaments.
 */
function eloProgression(rows: EloRow[]): (StatPoint & { elo: number })[] {
  let elo = ELO_INITIAL;
  return (
    [...rows]
      // `finished_at` is null only if a rated tournament has no completed board
      // for this player, which eloParticipants' all-four-boards rule makes
      // unreachable; treating it as 0 sorts it oldest and leaves it in the id
      // order it arrived in, which is the best available guess either way.
      .sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0) || a.tournament_id - b.tournament_id)
      .map((r) => {
        elo += r.after - r.before;
        return {
          tournamentId: r.tournament_id,
          tournamentName: r.tournament_name,
          finishedAt: r.finished_at,
          elo,
        };
      })
  );
}

/**
 * `getStandings` is injectable so a caller building TWO profiles in one request
 * (compare.ts) pays `fieldPercentiles`'s site-wide sweep once instead of twice —
 * that sweep matchpoints every standard tournament in the database, and it is
 * comfortably the most expensive thing this function does. Omitting it keeps
 * the original behaviour exactly: a fresh closure per call, so no cross-request
 * staleness is possible.
 */
export function playerStats(
  userId: number,
  getStandings: (tournamentId: number) => StandingDetail[] = memoizedStandings(),
): PlayerStats | null {
  const u = stmtUser.get(userId) as
    | { id: number; handle: string; picture: string | null; elo: number; created_at: number; kind: 'human' | 'ai' }
    | undefined;
  if (!u) return null;

  const eloSeries = eloProgression(stmtEloSeries.all(userId) as EloRow[]);

  const boards = stmtDoneBoards.all(userId) as DoneBoardRow[];

  const gradeCounts = { excellent: 0, good: 0, fair: 0, poor: 0 };
  const declarer = { boards: 0, made: 0 };
  const defense = { boards: 0, beat: 0 };
  let passedOut = 0;
  const allScores: number[] = [];
  const byTournament = new Map<number, { name: string; finishedAt: number; scores: number[] }>();
  const byBidType = new Map<BidCategory, { total: number; satisfactory: number }>();
  const byConvention = new Map<ConventionFamily, { total: number; satisfactory: number }>();
  const trickDeltaHist = new Map<number, number>(); // clamped delta -> count
  const trickDeltas: number[] = []; // unclamped, for the true average
  const contractMix = {
    partscore: { boards: 0, made: 0 },
    game: { boards: 0, made: 0 },
    slam: { boards: 0, made: 0 },
    doubled: { boards: 0, made: 0 },
    strains: { notrump: 0, major: 0, minor: 0 },
  };
  const byDay = new Map<string, number>(); // UTC 'YYYY-MM-DD' -> completed-board count
  // '<tournamentId>:<boardNo>' -> when it was finished, so the tops tally below
  // can pick the most recent one by actual completion time rather than assuming
  // board order within a tournament.
  const doneAt = new Map<string, number>();

  for (const b of boards) {
    const t = byTournament.get(b.tournament_id) ?? { name: b.tournament_name, finishedAt: 0, scores: [] };
    t.finishedAt = Math.max(t.finishedAt, b.updated_at);
    const evals = JSON.parse(b.bid_evals) as EvalRow[];
    for (const e of evals) {
      gradeCounts[e.grade]++;
      t.scores.push(e.score);
      allScores.push(e.score);
    }
    byTournament.set(b.tournament_id, t);

    const day = new Date(b.updated_at * 1000).toISOString().slice(0, 10); // UTC 'YYYY-MM-DD'
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    doneAt.set(`${b.tournament_id}:${b.board_no}`, b.updated_at);

    // Re-pair each eval with its auction context: evals are appended one per
    // human call, so the nth eval belongs to the nth call made from the human
    // seat (South). The dealer comes from the standard board rotation, making
    // the whole classification a pure function of the stored auction.
    const calls = JSON.parse(b.calls) as Call[];
    const { dealer } = boardConditions(b.board_no);
    let n = 0;
    for (let i = 0; i < calls.length && n < evals.length; i++) {
      if ((dealer + i) % 4 !== HUMAN_SEAT) continue;
      const e = evals[n++];
      const category = bidCategory(dealer, calls.slice(0, i), calls[i]);
      const bucket = byBidType.get(category) ?? { total: 0, satisfactory: 0 };
      bucket.total++;
      if (e.grade === 'excellent' || e.grade === 'good') bucket.satisfactory++;
      byBidType.set(category, bucket);

      // second axis: which named convention (if any) this call was
      const family = conventionFamily(explainBid(dealer, calls.slice(0, i), calls[i]));
      if (family) {
        const cbucket = byConvention.get(family) ?? { total: 0, satisfactory: 0 };
        cbucket.total++;
        if (e.grade === 'excellent' || e.grade === 'good') cbucket.satisfactory++;
        byConvention.set(family, cbucket);
      }
    }

    const contract = b.contract ? (JSON.parse(b.contract) as Contract) : null;
    if (!contract) {
      passedOut++;
    } else {
      if (contract.declarer % 2 === 0) {
        // the human always sits N-S, so an even declarer seat is the user's side
        declarer.boards++;
        const tricks = b.tricks_declarer ?? 0;
        const made = tricks >= 6 + contract.level;
        if (made) declarer.made++;
        const delta = tricks - (6 + contract.level);
        const clamped = Math.max(-3, Math.min(3, delta));
        trickDeltaHist.set(clamped, (trickDeltaHist.get(clamped) ?? 0) + 1);
        trickDeltas.push(delta);

        const tier = contractMix[contractTier(contract.level, contract.strain)];
        tier.boards++;
        if (made) tier.made++;
        if (contract.doubled || contract.redoubled) {
          contractMix.doubled.boards++;
          if (made) contractMix.doubled.made++;
        }
        contractMix.strains[strainFamily(contract.strain)]++;
      } else {
        defense.boards++;
        if ((b.tricks_declarer ?? 0) < 6 + contract.level) defense.beat++;
      }
    }
  }

  // Ordered by the user's play order — their learning timeline, and the x axis
  // of pctSeries/accuracySeries below (see StatPoint's doc comment for why that
  // is finishedAt and never tournament id). updated_at is second-resolution, so
  // two crossings genuinely can share a finish second — a persona sweep or a
  // claim fast-forward closes boards fast — and the id tie-break keeps the order
  // deterministic rather than leaning on the sort being stable.
  const tournaments = [...byTournament.entries()].sort((a, b) => a[1].finishedAt - b[1].finishedAt || a[0] - b[0]);

  // `getStandings` (the parameter) is shared across pctSeries/rivalries/
  // fieldPercentiles below, so a tournament this player has played gets
  // matchpointed once per request instead of up to three times over — see
  // memoizedStandings()'s doc comment.
  const rivals = rivalries(
    userId,
    tournaments.map(([tid]) => tid),
    getStandings,
  );

  const accuracySeries = tournaments.map(([tid, t]) => ({
    tournamentId: tid,
    tournamentName: t.name,
    finishedAt: t.finishedAt,
    accuracy: t.scores.length ? Math.round(mean(t.scores) * 100) : null,
    calls: t.scores.length,
  }));

  let tournamentsCompleted = 0;
  // Accumulated in the pctSeries pass below. `at` is the completion time of the
  // board `latest` points at — a tie-break for "most recent", never returned.
  const tops: { count: number; latest: { tournamentId: number; boardNo: number } | null; at: number } = {
    count: 0,
    latest: null,
    at: 0,
  };
  const pctSeries = tournaments.flatMap(([tid, t]) => {
    const field = getStandings(tid);
    const mine = field.find((s) => s.userId === userId);
    if (!mine || mine.totalPct === null) return [];
    if (mine.complete) tournamentsCompleted++;
    // Tops ride along on the same memoized standings pass — see totals.tops.
    // The `>=` keeps the LAST board iterated on a tie, deliberately the
    // opposite of bestPct's earliest-wins convention below: that one credits
    // the first time a score was reached, this one wants the freshest link.
    // Ties are real — updated_at is second-resolution (db.ts) and a persona
    // sweeping a tournament or a claim fast-forward can finish two boards
    // inside one second — and iteration order is fixed (tournaments
    // oldest-first, boards ascending), so the winner is deterministic either
    // way; the later-iterated board is simply the better guess at "most
    // recent", since boards are normally played in ascending order.
    for (const { no, pct } of mine.boardPcts) {
      if (pct !== 100) continue;
      tops.count++;
      const at = doneAt.get(`${tid}:${no}`) ?? 0;
      if (!tops.latest || at >= tops.at) {
        tops.latest = { tournamentId: tid, boardNo: no };
        tops.at = at;
      }
    }
    return [
      {
        tournamentId: tid,
        tournamentName: t.name,
        finishedAt: t.finishedAt,
        pct: mine.totalPct,
        boards: mine.boardsDone,
        // the whole field — house rows are pairs too
        fieldSize: field.length,
      },
    ];
  });

  // Personal-best callout: a plain max reduction over pctSeries, which is
  // already chronological — a strict > comparison keeps the earliest
  // tournament on a tie (same tie-break convention as bidTypes' sort below).
  const bestPct = pctSeries.length ? pctSeries.reduce((best, p) => (p.pct > best.pct ? p : best)) : null;

  const avgPct = pctSeries.length ? round1(mean(pctSeries.map((p) => p.pct))) : null;
  const avgBidAccuracy = allScores.length ? Math.round(mean(allScores) * 100) : null;

  const TRICK_DELTA_BUCKETS = [-3, -2, -1, 0, 1, 2, 3] as const;
  const trickDelta = {
    buckets: TRICK_DELTA_BUCKETS.map((delta) => ({ delta, count: trickDeltaHist.get(delta) ?? 0 })),
    boards: declarer.boards,
    avgDelta: trickDeltas.length ? round1(mean(trickDeltas)) : null,
  };

  // ranked best to worst; ties break toward the larger sample, then alphabetically
  const bidTypes = [...byBidType.entries()]
    .map(([category, counts]) => ({ category, ...counts }))
    .sort(
      (a, b) =>
        b.satisfactory / b.total - a.satisfactory / a.total ||
        b.total - a.total ||
        a.category.localeCompare(b.category),
    );

  const conventions = [...byConvention.entries()]
    .map(([family, counts]) => ({ family, ...counts }))
    .sort(
      (a, b) =>
        b.satisfactory / b.total - a.satisfactory / a.total ||
        b.total - a.total ||
        a.family.localeCompare(b.family),
    );

  const declaringRate = declarer.boards ? Math.round((declarer.made / declarer.boards) * 100) : null;

  // 'YYYY-MM-DD' sorts lexically = chronologically, so localeCompare is a
  // plain ascending date sort here.
  const dailyBoards = [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    user: { id: u.id, handle: u.handle, picture: u.picture, elo: u.elo, createdAt: u.created_at, kind: u.kind },
    totals: {
      boardsCompleted: boards.length,
      tournamentsPlayed: byTournament.size,
      tournamentsCompleted,
      streakDays: longestDayStreak(dailyBoards.map((d) => d.date)),
      currentElo: u.elo,
      // Read off the same series the RATING chart draws, deliberately, rather
      // than off elo_history's raw `after` column: the two maxima can differ
      // once a backfilled crossing reorders things (see eloProgression), and
      // neither dominates the other — so taking the chain's would sometimes
      // print a PEAK the line sitting under it visibly exceeds.
      peakElo: Math.max(ELO_INITIAL, ...eloSeries.map((e) => e.elo)),
      avgPct,
      bestPct: bestPct ? { pct: bestPct.pct, tournamentName: bestPct.tournamentName, tournamentId: bestPct.tournamentId } : null,
      tops: { count: tops.count, latest: tops.latest },
      avgBidAccuracy,
      gradeCounts,
      declarer,
      defense,
      passedOut,
      monthlyEloDelta: monthlyEloDelta(u.elo, eloSeries),
    },
    trickDelta,
    percentiles: fieldPercentiles(u.elo, eloSeries.length > 0, avgPct, avgBidAccuracy, declaringRate, getStandings),
    eloSeries,
    pctSeries,
    accuracySeries,
    bidTypes,
    conventions,
    contractMix,
    dailyBoards,
    rivals,
  };
}

/**
 * Rating change since the start of the current UTC month. The baseline is the
 * rating after the player's last tournament finished before this month (1200
 * when their whole rated history is inside the month); unrated players get
 * null. Like everything Elo here, a full recompute can shift this
 * retroactively — that's the evergreen model, not a bug.
 *
 * "Last tournament finished before this month" is a wall-clock claim, so it
 * relies on eloSeries being in play order: reading the raw id-ordered chain, the
 * final pre-month row is merely the highest-id one, and a crossing finished
 * mid-month can sit past it and be skipped.
 */
function monthlyEloDelta(currentElo: number, eloSeries: (StatPoint & { elo: number })[]): number | null {
  if (!eloSeries.length) return null;
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  let baseline = ELO_INITIAL;
  for (const p of eloSeries) {
    if (p.finishedAt !== null && p.finishedAt < monthStart) baseline = p.elo;
  }
  return currentElo - baseline;
}

/**
 * Where the player sits in the whole field, per metric. Populations differ on
 * purpose: elo only means something for rated players (which excludes the
 * benchmark AI personas — they never rate), while score/accuracy compare
 * against everyone who has completed at least one board, personas included.
 */
function fieldPercentiles(
  elo: number,
  isRated: boolean,
  avgPct: number | null,
  avgBidAccuracy: number | null,
  declaringRate: number | null,
  getStandings: (id: number) => StandingDetail[],
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

  // tournament-weighted mean pct per user (any kind — the personas are pool
  // members like everyone else, so betterThan's "everyone but me"
  // denominator is right for every profile, persona pages included), from
  // one standings() pass per tournament — via getStandings, so the subject's
  // own tournaments (already matchpointed for pctSeries/rivalries above)
  // aren't matchpointed a second time here
  const pctsByUser = new Map<number, number[]>();
  for (const { id } of stmtAllTournamentIds.all() as { id: number }[]) {
    for (const s of getStandings(id)) {
      if (s.totalPct === null) continue;
      pctsByUser.set(s.userId, [...(pctsByUser.get(s.userId) ?? []), s.totalPct]);
    }
  }
  const avgPcts = [...pctsByUser.values()].map((p) => round1(mean(p)));

  // declaring-side make-rate per user (same declarer-side filter as
  // totals.declarer — every player always sits South, so it applies row-wise
  // across the whole table, not just for the profile subject)
  const declareByUser = new Map<number, { boards: number; made: number }>();
  for (const row of stmtAllDoneContracts.all() as { user_id: number; contract: string; tricks_declarer: number | null }[]) {
    const contract = JSON.parse(row.contract) as Contract;
    if (contract.declarer % 2 !== 0) continue;
    const rec = declareByUser.get(row.user_id) ?? { boards: 0, made: 0 };
    rec.boards++;
    if ((row.tricks_declarer ?? 0) >= 6 + contract.level) rec.made++;
    declareByUser.set(row.user_id, rec);
  }
  const declareRates = [...declareByUser.values()].map((r) => Math.round((r.made / r.boards) * 100));

  return {
    elo: isRated ? betterThan(elo, ratedElos) : null,
    avgPct: avgPct !== null ? betterThan(avgPct, avgPcts) : null,
    bidAccuracy: avgBidAccuracy !== null ? betterThan(avgBidAccuracy, accuracies) : null,
    declaring: declaringRate !== null ? betterThan(declaringRate, declareRates) : null,
    ratedPlayers: ratedElos.length,
    activePlayers: scoresByUser.size,
    declaringPlayers: declareByUser.size,
  };
}
