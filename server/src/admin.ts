import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';

/**
 * Admin-only player roster export.
 *
 * There is no analytics stack and no admin UI, so the operator's only route to
 * "who is actually playing this" used to be running a SQLite query on the
 * production machine over the Fly Machines API. That works, but it means
 * handing a remote-exec shell to whatever is doing the asking, for what is
 * really a read of six aggregate columns. This endpoint is that read, served
 * by the app that already owns the database.
 *
 * It hands out every player's name and email address, so treat the token as a
 * production credential:
 *
 *   - **Disabled unless `ADMIN_TOKEN` is set.** Unset means the routes 404 —
 *     not 503, not "unauthorized", because an endpoint that announces its own
 *     existence to anonymous callers is just a prompt to go looking for the
 *     token.
 *   - **A short token disables it too**, loudly, at startup. A guessable
 *     secret in front of everyone's email address is worse than no feature,
 *     and the failure mode we want is "the export stops working and says why",
 *     never "the export quietly protects nothing".
 *   - Comparison is `timingSafeEqual` on equal-length buffers.
 *   - Responses are `no-store`. This is PII; it has no business in a shared
 *     cache or a proxy log.
 *
 * Unlike `DEV_AUTH` and `DEMO` (see invariant 5 in CONTRIBUTING.md), this is
 * *meant* to be enabled in production — that is the entire point of it. The
 * safety property is the strength of the token, not its absence.
 */

/** Below this, a token is guessable enough that we refuse to rely on it. */
const MIN_TOKEN_LENGTH = 24;

function configuredToken(): string | null {
  const raw = process.env.ADMIN_TOKEN ?? '';
  return raw.length >= MIN_TOKEN_LENGTH ? raw : null;
}

/**
 * Constant-time bearer check. Length is compared first and separately because
 * `timingSafeEqual` throws on mismatched buffers — that length leak is
 * unavoidable and uninteresting next to the token's own entropy.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = configuredToken();
  if (!expected) {
    reply.code(404).send({ error: 'not found' });
    return false;
  }
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented || !tokenMatches(presented, expected)) {
    reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/**
 * The roster query.
 *
 * Two board counts matter and they are not the same number. `boards_done` is
 * the intuitive "how much have they played". `rated_tournaments` is what
 * actually gates the leaderboard (`PROVISIONAL_MIN_TOURNAMENTS` in
 * tournaments.ts), and a tournament only rates a player who finished ALL FOUR
 * of its boards in a field where 2+ humans did the same (`eloParticipants`).
 * So sixteen finished boards spread over half-played tournaments still earns
 * no leaderboard row, and only `rated_tournaments` can tell you that.
 *
 * The `ab_*` columns describe the unfinished board a player walked away from
 * (their most recently touched one). `calls` and `plays` are JSON arrays, so
 * their lengths are exactly how far that board got — see stopPoint() below.
 */
const stmtRoster = db.prepare(`
  SELECT
    u.id                AS id,
    u.email             AS email,
    u.name              AS name,
    u.handle            AS handle,
    u.elo               AS elo,
    date(u.created_at, 'unixepoch')                     AS signed_up,
    (SELECT COUNT(*) FROM boards b
      WHERE b.user_id = u.id AND b.state = 'done')      AS boards_done,
    (SELECT COUNT(*) FROM boards b
      WHERE b.user_id = u.id)                           AS boards_started,
    (SELECT COUNT(*) FROM elo_history h
      WHERE h.user_id = u.id)                           AS rated_tournaments,
    (SELECT COUNT(DISTINCT b.tournament_id) FROM boards b
       JOIN tournaments t ON t.id = b.tournament_id AND t.kind = 'standard'
      WHERE b.user_id = u.id)                           AS tournaments_touched,
    (SELECT COUNT(DISTINCT date(b.updated_at, 'unixepoch')) FROM boards b
      WHERE b.user_id = u.id)                           AS days_seen,
    (SELECT date(MAX(b.updated_at), 'unixepoch') FROM boards b
      WHERE b.user_id = u.id)                           AS last_seen,
    (SELECT date(MIN(b.updated_at), 'unixepoch') FROM boards b
      WHERE b.user_id = u.id)                           AS first_seen,
    (SELECT b.board_no FROM boards b
      WHERE b.user_id = u.id AND b.state != 'done'
      ORDER BY b.updated_at DESC LIMIT 1)               AS ab_board,
    (SELECT json_array_length(b.calls) FROM boards b
      WHERE b.user_id = u.id AND b.state != 'done'
      ORDER BY b.updated_at DESC LIMIT 1)               AS ab_calls,
    (SELECT json_array_length(b.plays) FROM boards b
      WHERE b.user_id = u.id AND b.state != 'done'
      ORDER BY b.updated_at DESC LIMIT 1)               AS ab_plays
  FROM users u
  WHERE u.kind = 'human'
  ORDER BY u.id
`);
// Only `kind = 'human'` is filtered — the three benchmark AI personas play
// constantly and would swamp every cohort. Accounts *without* an email are
// deliberately still included: Google always supplies one in production, but a
// roster that silently omits real players to suit the one consumer that needs
// a mailbox is a roster you can't trust for counting. Skip them when drafting,
// not when reporting.

const stmtToday = db.prepare(`SELECT date('now') AS d`);

export type Cohort = 'retained' | 'friction' | 'abandoned_first' | 'never_played';

interface RosterRow {
  id: number;
  email: string | null;
  name: string;
  handle: string | null;
  elo: number;
  signed_up: string;
  boards_done: number;
  boards_started: number;
  rated_tournaments: number;
  tournaments_touched: number;
  days_seen: number;
  last_seen: string | null;
  first_seen: string | null;
  ab_board: number | null;
  ab_calls: number | null;
  ab_plays: number | null;
}

export interface RosterPlayer extends RosterRow {
  cohort: Cohort;
  on_leaderboard: boolean;
  excluded: boolean;
  too_recent: boolean;
  quiet_days: number | null;
  stopped_at: 'auction' | 'play' | null;
  human_calls: number | null;
}

/** Rated tournaments needed for a leaderboard row (PROVISIONAL_MIN_TOURNAMENTS). */
const LEADERBOARD_MIN_RATED = 4;
const RETAINED_BOARDS = 16; // ≈ the 4 rated tournaments the leaderboard needs
const RETAINED_DAYS = 2;
const DEFAULT_COOLDOWN_DAYS = 3;

/**
 * `retained` is tested before `friction` because the two overlap: a player
 * with 5 boards across 3 days satisfies both "fewer than 16 boards" and "came
 * back on a second day". Returning is the stronger statement about what they
 * experienced — they chose to come back — so it wins, which leaves `friction`
 * as the clean complement: tried it, on one day, never returned.
 *
 * `abandoned_first` is split out of `never_played` because the two are
 * different problems wearing the same zero. Someone who signed up and never
 * opened a board is a marketing-channel question. Someone who was dealt a hand
 * and left mid-board saw the actual product and it lost them in minutes.
 */
function cohortOf(r: RosterRow, onLeaderboard: boolean): Cohort {
  if (r.boards_done === 0) return r.ab_board === null ? 'never_played' : 'abandoned_first';
  if (r.boards_done >= RETAINED_BOARDS || r.days_seen >= RETAINED_DAYS || onLeaderboard) return 'retained';
  return 'friction';
}

/**
 * Where an abandoned board stopped, and whether the player ever bid.
 *
 * The seat maths is packages/core's, not folklore: seats are 0=N 1=E 2=S 3=W
 * with the human always South (types.ts), `boardConditions` sets
 * `dealer = (boardNo - 1) % 4`, and `auctionState` puts seat `(dealer + i) % 4`
 * on call `i`. South's first turn is therefore index `(2 - dealer + 4) % 4`,
 * and every fourth call after that.
 *
 * `human_calls === 0` is the interesting case: they reached their first
 * decision and made none. Bidding seats never flip — the North-hand flip in
 * game.ts is a card-play concern only.
 */
function stopPoint(r: RosterRow): Pick<RosterPlayer, 'stopped_at' | 'human_calls'> {
  if (r.ab_board === null) return { stopped_at: null, human_calls: null };
  const dealer = (r.ab_board - 1) % 4;
  const firstTurn = (2 - dealer + 4) % 4;
  const calls = r.ab_calls ?? 0;
  return {
    stopped_at: (r.ab_plays ?? 0) > 0 ? 'play' : 'auction',
    human_calls: calls > firstTurn ? Math.ceil((calls - firstTurn) / 4) : 0,
  };
}

/** Whole days between two YYYY-MM-DD strings, or null if either is missing. */
function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface RosterOptions {
  /** Days of silence before a `friction` player is fair to call churned. */
  cooldownDays?: number;
  /**
   * Emails or handles to mark `excluded` — operator/opt-out accounts. Handles
   * are accepted alongside addresses because the operator usually knows who
   * they mean by handle, and an account may have no email at all.
   */
  exclude?: string[];
}

export interface RosterReport {
  generated_on: string;
  cooldown_days: number;
  totals: Record<string, number>;
  players: RosterPlayer[];
}

export function roster(opts: RosterOptions = {}): RosterReport {
  const cooldownDays = opts.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const excluded = new Set((opts.exclude ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const today = (stmtToday.get() as { d: string }).d;

  const players: RosterPlayer[] = (stmtRoster.all() as RosterRow[]).map((r) => {
    const on_leaderboard = r.rated_tournaments >= LEADERBOARD_MIN_RATED;
    const cohort = cohortOf(r, on_leaderboard);
    const quiet_days = daysBetween(r.last_seen, today);
    return {
      ...r,
      ...stopPoint(r),
      cohort,
      on_leaderboard,
      quiet_days,
      excluded: excluded.has((r.email ?? '').toLowerCase()) || excluded.has((r.handle ?? '').toLowerCase()),
      // Held while the claim would still be false. Both of these cohorts are
      // written to with a message that tells its reader they left, and that
      // isn't yet true of someone who played an hour ago. `abandoned_first`
      // needs the guard at least as much as `friction` does: an abandoned
      // board is only "abandoned" in retrospect, so without a cooldown a
      // player who opened their first board a minute ago and is sitting on
      // the bid box right now reads as `never_bid` — and would be told they
      // walked away while they are mid-hand.
      //
      // They share one cooldown deliberately. The semantics are identical
      // ("don't say they left until they have been gone a while") and a
      // second constant would drift. There is a real tension for
      // `abandoned_first` — its whole value is reaching people while they
      // still remember what confused them — so an operator who wants speed
      // over certainty passes a smaller `cooldown_days`.
      too_recent:
        (cohort === 'friction' || cohort === 'abandoned_first') && quiet_days !== null && quiet_days < cooldownDays,
    };
  });

  /**
   * Every derived total is computed over the non-excluded population. That is
   * the whole point of `excluded`: operator and opt-out accounts stay in
   * `players` so the roster is complete, but they must not skew any aggregate
   * — the operator plays their own game constantly and would otherwise sit at
   * the top of the leaderboard count and carry stale unfinished boards.
   *
   * `players` and `excluded` are the two deliberate exceptions, since those
   * describe the whole population rather than a slice of it.
   */
  const mailable = players.filter((p) => !p.excluded);
  const inCohort = (c: Cohort) => mailable.filter((p) => p.cohort === c);
  const abandoned = inCohort('abandoned_first');
  return {
    generated_on: today,
    cooldown_days: cooldownDays,
    totals: {
      players: players.length,
      excluded: players.length - mailable.length,
      retained: inCohort('retained').length,
      // `*_held` splits are batch counts — who to write to *this* run. The
      // diagnostic breakdowns below describe the cohort as a whole, held rows
      // included, because a player being too recent to email doesn't make
      // them less a part of the funnel you're trying to understand.
      friction: inCohort('friction').filter((p) => !p.too_recent).length,
      friction_held: inCohort('friction').filter((p) => p.too_recent).length,
      abandoned_first: abandoned.filter((p) => !p.too_recent).length,
      abandoned_first_held: abandoned.filter((p) => p.too_recent).length,
      abandoned_in_auction: abandoned.filter((p) => p.stopped_at === 'auction').length,
      abandoned_in_play: abandoned.filter((p) => p.stopped_at === 'play').length,
      never_bid: abandoned.filter((p) => p.human_calls === 0).length,
      never_played: inCohort('never_played').length,
      on_leaderboard: mailable.filter((p) => p.on_leaderboard).length,
      abandoned_mid_board: mailable.filter((p) => p.boards_started > p.boards_done).length,
    },
    players,
  };
}

const CSV_COLUMNS = [
  'id', 'email', 'name', 'handle', 'cohort', 'excluded', 'too_recent', 'boards_done',
  'boards_started', 'stopped_at', 'human_calls', 'ab_board', 'days_seen', 'quiet_days',
  'last_seen', 'first_seen', 'signed_up', 'rated_tournaments', 'on_leaderboard',
  'tournaments_touched', 'elo',
] as const;

/**
 * RFC 4180 quoting. A leading `=`/`+`/`-`/`@` is also prefixed with a single
 * quote: display names are user-controlled, and a spreadsheet opening this
 * file would otherwise treat such a cell as a formula.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function rosterCsv(report: RosterReport): string {
  const header = CSV_COLUMNS.join(',');
  const rows = report.players.map((p) => CSV_COLUMNS.map((c) => csvCell(p[c as keyof RosterPlayer])).join(','));
  return [header, ...rows].join('\n') + '\n';
}

/**
 * Fastify's default query parser turns a repeated key into an array, so
 * `?exclude=a&exclude=b` arrives as `['a', 'b']` rather than a string. Callers
 * reach that shape by accident all the time — a script appending one param per
 * item instead of joining with commas — so accept both spellings rather than
 * throwing a 500 at someone who wrote a perfectly reasonable query string.
 */
function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => String(v).split(','));
  if (typeof value === 'string') return value.split(',');
  return [];
}

/** Last value wins for a repeated scalar; anything unparseable falls back. */
function queryNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseOptions(req: FastifyRequest): RosterOptions {
  const q = req.query as Record<string, unknown>;
  return {
    cooldownDays: queryNumber(q.cooldown_days),
    exclude: [...queryList(process.env.ADMIN_EXCLUDE_EMAILS), ...queryList(q.exclude)],
  };
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // Surface a misconfigured token once, at boot, rather than letting the
  // operator discover it as a 404 at the moment they need the export.
  const raw = process.env.ADMIN_TOKEN ?? '';
  if (raw && raw.length < MIN_TOKEN_LENGTH) {
    app.log.error(
      `ADMIN_TOKEN is set but shorter than ${MIN_TOKEN_LENGTH} characters — ` +
        `the admin roster routes stay DISABLED. Set a longer secret to enable them.`,
    );
  }

  app.get('/api/admin/players.json', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return reply.header('Cache-Control', 'no-store').send(roster(parseOptions(req)));
  });

  app.get('/api/admin/players.csv', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const report = roster(parseOptions(req));
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="nickel-bridge-players-${report.generated_on}.csv"`)
      .send(rosterCsv(report));
  });
}
