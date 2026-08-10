import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Difficulty, SettableDifficulty } from '@bridge/ai';

const DB_PATH = process.env.DB_PATH ?? './data/bridge.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT NOT NULL,
  picture TEXT,
  elo INTEGER NOT NULL DEFAULT 1200,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  seed TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  -- 1..4. The CHECK is on the storage CLASS, not the range, and both halves of
  -- that are deliberate. INTEGER here is an affinity rather than a type: this
  -- table is not STRICT, so SQLite stores 2.5 verbatim as a REAL — a value
  -- distinct from every other under UNIQUE below, i.e. an unbounded supply of
  -- extra "boards" per (tournament, user). typeof() is what actually refuses
  -- that. The 1..4 range stays at the route (app.ts's boardNoParam), because
  -- it is a rule about the game rather than about the row, and test suites
  -- legitimately fabricate rows past the fourth board to stand in for days of
  -- play. Note this only reaches databases created from this DDL: SQLite
  -- cannot add a constraint to an existing table without rebuilding it, and a
  -- rebuild of the production boards table is not worth it for a hole the
  -- boundary check already closes.
  board_no INTEGER NOT NULL CHECK (typeof(board_no) = 'integer'),
  state TEXT NOT NULL DEFAULT 'bidding', -- bidding | playing | done
  calls TEXT NOT NULL DEFAULT '[]',      -- JSON number[]
  plays TEXT NOT NULL DEFAULT '[]',      -- JSON number[]
  bid_evals TEXT NOT NULL DEFAULT '[]',  -- JSON: evaluation per human call
  contract TEXT,                          -- JSON Contract | null once auction ends
  tricks_declarer INTEGER,
  score_ns INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (tournament_id, user_id, board_no)
);

CREATE TABLE IF NOT EXISTS elo_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  before INTEGER NOT NULL,
  after INTEGER NOT NULL
);

-- Analyze's per-board verdict cache (server/src/analyze.ts). Computed on the
-- FIRST open of a board's analysis — never on completion — and served cached
-- thereafter: the pipeline is seeded and DDS is deterministic, so a recompute
-- is byte-identical (the cache and the screen are the same claim made twice).
-- "core" holds stages 1-3 (DD trace, per-ply verdicts, moments); "par" holds
-- stage 4 (DD table, par, counterfactual auctions) and stays NULL until a
-- lens that needs it is opened, so a play-lens read never pays for
-- CalcDDTablePBN. A version mismatch (ANALYZE_VERSION) forces a recompute —
-- a cached analysis computed against different robots is a stale accusation.
-- ON DELETE CASCADE is load-bearing: boards are deleted by demo mode's
-- per-exhibit wipe-unfinished-then-replay (demo.ts) and full reset
-- (demo-seed.ts), and with foreign_keys ON a cache row without the cascade
-- turns either into FOREIGN KEY constraint failed — a cache must never be
-- able to block its parent's delete.
CREATE TABLE IF NOT EXISTS board_analyses (
  board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  core TEXT NOT NULL,
  par TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_boards_tournament ON boards(tournament_id, board_no);
CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
-- Every other board sweep in the codebase is scoped to one user or one
-- tournament, so idx_boards_user (user-first) serves them. The activity feed
-- (activity.ts) is the one query that starts from a time window and spans all
-- users, and it would otherwise scan the whole table on every load.
CREATE INDEX IF NOT EXISTS idx_boards_updated ON boards(updated_at);
`);

// Migration: `handle`/`handle_key` were added after the initial schema, so existing
// databases need an explicit ALTER TABLE (CREATE TABLE IF NOT EXISTS above is a no-op
// on them). `handle` is the user-chosen display name shown everywhere in the app;
// `handle_key` is its lowercased form, used only to enforce case-insensitive uniqueness
// via a partial index (NULL until a user completes the first-login handle prompt).
const userColumns = new Set((db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name));
if (!userColumns.has('handle')) db.exec(`ALTER TABLE users ADD COLUMN handle TEXT`);
if (!userColumns.has('handle_key')) db.exec(`ALTER TABLE users ADD COLUMN handle_key TEXT`);
// Migration: robot difficulty preference — the tier a user wants placement to
// match them into (see tournaments.difficulty below). Backend-only for now:
// settable via POST /api/me/difficulty, no web UI yet. Default is the middle
// tier — nobody faces the legacy perfect-knowledge robots unknowingly.
if (!userColumns.has('difficulty')) {
  db.exec(`ALTER TABLE users ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'intermediate'`);
}
// Migration: `kind` discriminates the three benchmark AI personas ('ai',
// created only by ensureAiPlayers in ai-players.ts) from real accounts.
// A first-class column, not a google_id prefix convention, for the same
// reason as tournaments.kind below: standings, Elo, placement, leaderboard,
// and stats all must partition on it, and hanging that on an id string
// would break the moment the id scheme changes.
if (!userColumns.has('kind')) {
  db.exec(`ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_key ON users(handle_key) WHERE handle_key IS NOT NULL;`);
// Migration: `onboarded_at` — when the user finished (or skipped) the
// first-crossing tour (web/src/onboarding). NULL = the web app shows the tour
// after the handle prompt. Existing accounts are grandfathered as already
// onboarded at migration time: the tour teaches the app to newcomers, and
// springing it on every veteran the day it ships would read as a nag, not a
// welcome.
if (!userColumns.has('onboarded_at')) {
  db.exec(`ALTER TABLE users ADD COLUMN onboarded_at INTEGER`);
  db.exec(`UPDATE users SET onboarded_at = unixepoch()`);
}
// Migration: `ladder_listed` — may a visitor without an account see this
// player on /leaderboard? The ladder is the ONLY thing about a human that
// reads signed out (profiles refuse an anonymous caller, the activity feed is
// gated), so this one flag is the whole of "can I be seen by someone who
// hasn't signed in". Defaults to 1, which is exactly the behaviour every
// existing account already had — this adds a way out, it doesn't change what
// happens to anyone who ignores it. Signed-in players always see the full
// ladder: the setting is about strangers, not about hiding from the field you
// are being scored against.
if (!userColumns.has('ladder_listed')) {
  db.exec(`ALTER TABLE users ADD COLUMN ladder_listed INTEGER NOT NULL DEFAULT 1`);
}
// Migration: `auto_claim` — may the server fast-play a settled tail on this
// player's behalf (1, the shipped behaviour), or should they play it out
// themselves (0)? Account state rather than a localStorage flag like the
// theme: it says how this PERSON wants to be handed a hand they no longer
// have decisions in, which doesn't change because they picked up a different
// device. Night mode is the exception, and only because it has to be applied
// before first paint by an inline script (see "Night mode" in
// CONTRIBUTING.md) — no server round trip can answer that in time.
//
// This is a REAL choice only because the claim gate became pessimistic (see
// the claim_rule migration below). Under the old gate a claim genuinely
// changed the outcome — it played the human's remaining decisions correctly
// on their behalf — so letting one player opt out would have handed two
// players on the identical board different games because of a checkbox, and
// fed that into matchpoints and Elo. That is why invariant 1 records the
// toggle as rejected. Once a claim requires the position to be settled under
// EVERY legal card, opting out cannot change a score: every tail scores the
// same, so this is pacing and nothing else.
//
// Which is also why it does not apply to 'optimistic' tournaments. There the
// old reasoning still holds in full, so those boards claim for everyone
// regardless of this column — see advanceRobots.
if (!userColumns.has('auto_claim')) {
  db.exec(`ALTER TABLE users ADD COLUMN auto_claim INTEGER NOT NULL DEFAULT 1`);
}
// Retired: `fast_forward` chose between a compressed claim replay (1) and one
// at ordinary table pacing (0). `auto_claim` above replaces it — the
// interesting question stopped being how fast to show you a settled tail and
// became whether to take it off you at all — and a settled tail now always
// replays compressed. Deliberately not dropped from databases that already
// have it: nothing reads the column, rewriting the users table buys nothing,
// and a DROP COLUMN would be the only destructive migration in this file. It
// is simply no longer created.
// Migration: `bid_feedback` — show the post-call grading toast (1, the
// shipped behaviour) or suppress it (0). The toast is deliberately excellent
// for a learner and unwanted noise for a stronger player who is here to
// compete rather than study. Account state, not localStorage, for the same
// reason as auto_claim: it describes how this PERSON wants to be coached,
// not a property of the device. Purely a rendering gate — grading is still
// computed and stored in bidEvals on every submitCall regardless of this
// flag, so bid-accuracy stats and the post-board "YOUR BIDDING" review table
// are unaffected either way.
if (!userColumns.has('bid_feedback')) {
  db.exec(`ALTER TABLE users ADD COLUMN bid_feedback INTEGER NOT NULL DEFAULT 1`);
}
// Migration: `double_tap_bid` — submit a bid on a second tap of the already-
// selected call, without pressing the confirm CTA (0, the shipped default;
// 1 opts back in). Unlike its three siblings above, this migration does NOT
// preserve prior behaviour on purpose: player reports of accidentally
// submitting a bid are exactly what turning this off by default fixes. The
// confirm CTA ("BID X →") is unaffected either way — it has always been an
// equal, independent path to the same submitCall, see BidBox.tsx — so this
// only removes the shortcut, never the ability to bid. Account state, not
// localStorage, for the same reason as auto_claim/bid_feedback: it
// describes how this PERSON wants to interact with the bid box, not a
// property of the device.
if (!userColumns.has('double_tap_bid')) {
  db.exec(`ALTER TABLE users ADD COLUMN double_tap_bid INTEGER NOT NULL DEFAULT 0`);
}
// Migration: `trick_clear_mode` — how a completed trick leaves the table:
// 'auto' (the shipped behaviour — the trick holds for GLIDE_MS + HOLD_MS,
// then sweeps to the winner on its own) or 'tap' (holds indefinitely until
// the player taps the trick area, then sweeps immediately). TEXT rather than
// the INTEGER boolean every sibling above uses: this is shipping with two
// values, but it names a MODE ("how"), not a yes/no toggle, so a third
// pacing choice later (a slower auto, say) extends the column instead of
// needing a second one — the same reasoning `difficulty`/`tournaments.kind`
// already use for their own TEXT enums. Defaults to 'auto', preserving prior
// behaviour for every existing account, same as auto_claim/bid_feedback/
// ladder_listed (double_tap_bid is the one sibling that deliberately does
// NOT do this). Account state, not localStorage, for the same reason as
// those three: it says how this PERSON wants a trick they can no longer
// affect to leave the table, not a property of the device. Purely a CLIENT
// pacing choice — server-side scoring, robot play and claim resolution never
// read this column.
if (!userColumns.has('trick_clear_mode')) {
  db.exec(`ALTER TABLE users ADD COLUMN trick_clear_mode TEXT NOT NULL DEFAULT 'auto'`);
}

// Migration: `beta_features` — opt in to features still being tried out
// before a general release (currently: Analyze, the post-board review
// screen). Unlike every other pref above, its default is environment-
// dependent rather than a fixed literal: DEFAULT is evaluated once, right
// here, against THIS process's env, which both backfills existing rows
// correctly for wherever this migration happens to run AND becomes SQLite's
// column default for every future INSERT that doesn't name the column (the
// same mechanism ladder_listed/auto_claim/bid_feedback lean on) — so a
// fresh signup needs no second code path to inherit it. Off (0) in
// production, where nobody has asked for early access yet; on (1) wherever
// DEV_AUTH or DEMO is set — PR previews and the permanent demo app share
// that exact shape (see deploy-preview/deploy-demo in ci.yml) — so testers
// and click-testers see new work without hunting for a switch. A production
// account reaches beta features only by deliberately flipping "Beta
// features" in Settings (POST /api/me/prefs), which is how a feature like
// Analyze reaches a handful of named testers ahead of everyone else.
if (!userColumns.has('beta_features')) {
  const betaDefault = process.env.DEV_AUTH === '1' || process.env.DEMO === '1' ? 1 : 0;
  db.exec(`ALTER TABLE users ADD COLUMN beta_features INTEGER NOT NULL DEFAULT ${betaDefault}`);
}

// Migration: `kind` discriminates demo-mode exhibit tournaments ('exhibit',
// created only by demo.ts under DEMO=1) from real ones ('standard'). It is a
// first-class column — not a name convention — because placement, the Elo
// replay, the lobby list, and stats all must exclude exhibits, and hanging
// that on a display string would break the moment tournament naming changes.
const tournamentColumns = new Set(
  (db.prepare(`PRAGMA table_info(tournaments)`).all() as { name: string }[]).map((c) => c.name),
);
if (!tournamentColumns.has('kind')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'`);
}
// Migration: robot card-play difficulty. `difficulty` is the tournament's
// placement-tier label, stamped at creation from the creating user's
// preference and immutable thereafter; `board_difficulties` is the per-board
// truth (JSON Difficulty[4], NULL = uniform at `difficulty`) — difficulty is
// a PER-BOARD property resolved via boardDifficulty() in tournaments.ts,
// identical for every player on a board (invariant 1), never per-user. The
// ADD COLUMN defaults backfill all existing tournaments as 'perfect' with a
// NULL schedule, i.e. exactly the historical true-DD robots on every board.
if (!tournamentColumns.has('difficulty')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'perfect'`);
}
if (!tournamentColumns.has('board_difficulties')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN board_difficulties TEXT`);
}
// Migration: `ai_field` marks tournaments whose Field includes the three
// benchmark AI personas (ai-players.ts). Stamped 1 only where tournaments
// are created for real play (placeUser's creation path and demo-seed's
// ambient tournaments) — never backfilled, so legacy tournaments, exhibit
// holders, and raw-inserted fixture/test tournaments keep 0 and can never
// acquire AI board rows.
if (!tournamentColumns.has('ai_field')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN ai_field INTEGER NOT NULL DEFAULT 0`);
}

// Migration: `origin_tournament_id`/`origin_board_no`/`branch_ply` identify a
// 'rehearsal'-kind tournament's origin — the real, finished board it branched
// from, and the plays[] index (see analyze.ts's ply convention) of the first
// redecided card. NULL for every non-rehearsal row. Kept directly on
// tournaments rather than a side table: a rehearsal is 1:1 with exactly one
// tournament row and one branch point, the same reasoning that already put
// kind/ai_field/board_difficulties here instead of elsewhere.
if (!tournamentColumns.has('origin_tournament_id')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN origin_tournament_id INTEGER REFERENCES tournaments(id)`);
}
if (!tournamentColumns.has('origin_board_no')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN origin_board_no INTEGER`);
}
if (!tournamentColumns.has('branch_ply')) {
  db.exec(`ALTER TABLE tournaments ADD COLUMN branch_ply INTEGER`);
}

// Migration: `claim_rule` — which auto-claim gate this tournament's boards
// play under, resolved by claimRule() in tournaments.ts. 'optimistic' is the
// legacy gate: claim the moment double dummy says one side takes 100% of the
// remaining tricks, which only holds while everyone keeps playing correctly —
// so the server was silently making the rest of the player's decisions (and
// upgrading weak-tier robots) to get there. 'pessimistic' additionally
// requires the position be OUTCOME-INVARIANT: no legal card by any of the four
// seats, in any continuation, can change the result (packages/ai/src/claim.ts).
//
// Note the ALTER/UPDATE pair, and that the default is the NEW value rather
// than the legacy one. Both halves are deliberate. Re-gating a board changes
// its deterministic replay, which invariant 1 forbids for boards already
// played, so every tournament that exists when this runs is stamped
// 'optimistic' and keeps the old gate forever; the ALTER's own default only
// backfills, and the UPDATE immediately corrects it. Which leaves the default
// free to be the rule we actually ship — and SQLite reuses an ADD COLUMN
// default for every future INSERT that omits the column, so this is what makes
// all five creation sites (placeUser, demo-seed, the two in demo.ts, and the
// tools' raw inserts) pick up the new gate with no per-site edit. The
// alternative — DEFAULT 'optimistic', stamp 'pessimistic' at each site — fails
// in the worse direction: a creation site added later by someone who never
// read this comment would silently keep over-claiming forever, which is the
// bug being fixed. This way a missed site merely claims less often.
//
// The one site that must NOT take the default is rehearsal.ts, which copies
// its origin's rule verbatim — a "Play From Here" branch of a legacy board has
// to reproduce that board's own claim, or replaying the origin's cards
// diverges. See createRehearsalTx.
//
// Immutable after creation, like `difficulty`. Analyze caches a board's claim
// boundary (board_analyses.core.claimedAtPly) without recording which rule
// produced it, which is safe precisely because the rule never changes under a
// board — so anything that ever flips this column on an existing tournament
// must delete that tournament's board_analyses rows.
if (!tournamentColumns.has('claim_rule')) {
  db.exec(`
    BEGIN;
    ALTER TABLE tournaments ADD COLUMN claim_rule TEXT NOT NULL DEFAULT 'pessimistic';
    UPDATE tournaments SET claim_rule = 'optimistic';
    COMMIT;
  `);
}

// Migration: renumber crossing display names off their ORDINAL among standard
// tournaments rather than off the raw row id — see crossingName() below for
// why the two must differ and why the ordinal is stable.
//
// This is the file's first DATA-only migration, so it cannot use the
// column-existence guard every migration above it uses: there is no new column
// to test for, and the UPDATE is O(n²) (a correlated COUNT per row), which is
// nothing at today's ~88 rows but is not something to re-run on every boot
// forever. PRAGMA user_version is SQLite's built-in slot for exactly this.
//
// Note the guard tests this migration's OWN number rather than a shared
// "current version" constant. The next data migration is its own
// `if (user_version < 2)` block setting 2, so that a database already past
// this one is never dragged back through it by a later bump.
//
// The subquery is deliberately the same `kind = 'standard' AND id <= x`
// expression crossingName() prepares, so a future edit to one is visibly an
// edit to the other rather than a silent divergence between what existing rows
// were named and what new ones get.
//
// Renaming rows players have already seen is intentional: this morning's
// "Tournament #100" becomes "#88". A gap-free sequence that is restated once
// beats one that is correct only from today on, which would leave a permanent
// discontinuity mid-history with no explanation attached to it.
if ((db.pragma('user_version', { simple: true }) as number) < 1) {
  db.exec(`
    BEGIN;
    UPDATE tournaments
       SET name = 'Tournament #' || (SELECT COUNT(*) FROM tournaments t2
                                      WHERE t2.kind = 'standard' AND t2.id <= tournaments.id)
     WHERE kind = 'standard';
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

// Migration: `claimed_at_ply` — the plays[] index of the first card the
// server played as part of resolving a laydown claim (advanceRobots'
// claim gate in game.ts), NULL when the board finished without claiming.
// GameBoard.claimed has always been transient (per-request, never saved), so
// before this column a finished board could not say whether — or where — its
// tail was claim-played. Analyze needs that boundary at rest: cards past it
// were played BY THE SERVER for both sides (true-DD, see invariant 1's claim
// note), so grading them against the human is a false statement. Backfilled
// NULL: pre-migration boards re-derive the boundary by replaying the claim
// gate's solve walk (server/src/analyze.ts), and cache the answer.
const boardColumns = new Set(
  (db.prepare(`PRAGMA table_info(boards)`).all() as { name: string }[]).map((c) => c.name),
);
if (!boardColumns.has('claimed_at_ply')) {
  db.exec(`ALTER TABLE boards ADD COLUMN claimed_at_ply INTEGER`);
}

// Migration: board_analyses briefly existed without ON DELETE CASCADE (see
// the DDL comment above — a cache row blocked board deletes). SQLite can't
// alter a foreign key in place, and the table is a pure recomputable cache,
// so a non-cascading copy is simply dropped and recreated empty.
const baFks = db.prepare(`PRAGMA foreign_key_list(board_analyses)`).all() as { on_delete: string }[];
if (baFks.length > 0 && baFks[0].on_delete !== 'CASCADE') {
  db.exec(`DROP TABLE board_analyses;
CREATE TABLE board_analyses (
  board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  core TEXT NOT NULL,
  par TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);`);
}

export interface UserRow {
  id: number;
  google_id: string;
  email: string | null;
  name: string;
  picture: string | null;
  handle: string | null;
  handle_key: string | null;
  /** robot difficulty preference — drives placement (see tournaments.difficulty); never 'perfect' */
  difficulty: SettableDifficulty;
  /** 'human' = real account; 'ai' = benchmark persona (ai-players.ts), excluded from Elo/placement/leaderboard/stats and shown as a shadow row in standings */
  kind: 'human' | 'ai';
  /** unix seconds when the first-crossing tour was completed or skipped; NULL = show it */
  onboarded_at: number | null;
  /** 1 = a signed-out visitor may see this player on /leaderboard; 0 = the ladder omits them for anonymous callers only */
  ladder_listed: number;
  /** 1 = replay a claim's settled tricks compressed; 0 = at ordinary play pacing */
  /** 1 = the server fast-plays a settled tail; 0 = the player plays it out. Ignored on 'optimistic' tournaments — see the migration comment. */
  auto_claim: number;
  /** 1 = show the post-call grading toast; 0 = suppress it (grading is still computed and stored either way) */
  bid_feedback: number;
  /** 1 = this account can reach features still in beta (e.g. Analyze); env-dependent default, see the migration comment in db.ts */
  beta_features: number;
  /** 1 = a second tap on the selected call submits it; 0 (default) = only the confirm CTA submits */
  double_tap_bid: number;
  /** how a completed trick leaves the table: 'auto' (default, times out on its own) or 'tap' (holds until the player taps the trick area) */
  trick_clear_mode: 'auto' | 'tap';
  elo: number;
  created_at: number;
}

/**
 * 'optimistic' = the legacy gate (double dummy says one side takes every
 * remaining trick); 'pessimistic' = that, AND no legal card by any of the four
 * seats can change the result. Per tournament rather than per board: duplicate
 * fairness only needs the rule identical for everyone on a board, which
 * tournament scope trivially gives, and unlike `difficulty` this is a property
 * of the server's own behaviour rather than of robot strength — so it wants no
 * per-board schedule to go with it.
 */
export type ClaimRule = 'optimistic' | 'pessimistic';

/** Tournaments never close: they stay joinable forever to maximize the field. */
export interface TournamentRow {
  id: number;
  name: string;
  seed: string;
  /** 'standard' = real play; 'exhibit' = demo-mode scenario holder; 'rehearsal' = a Play-From-Here branch — all three non-'standard' kinds are excluded from placement/rating/lobby/stats via the same kind='standard' allowlist everywhere */
  kind: 'standard' | 'exhibit' | 'rehearsal';
  /** placement-tier label ('perfect' = legacy true-DD); per-board truth via boardDifficulty() */
  difficulty: Difficulty;
  /** JSON Difficulty[4], one entry per board; NULL = uniform at `difficulty` */
  board_difficulties: string | null;
  /** 1 = the benchmark AI personas play this tournament (stamped at creation, never backfilled) */
  ai_field: number;
  /** which auto-claim gate this tournament's boards play under; immutable after creation, resolved by claimRule() — see the migration comment above */
  claim_rule: ClaimRule;
  /** rehearsal only: the real tournament/board this branched from, and the plays[] index of the first redecided card. NULL on every other kind. */
  origin_tournament_id: number | null;
  origin_board_no: number | null;
  branch_ply: number | null;
  created_at: number;
}

export const BOARDS_PER_TOURNAMENT = 4;

/**
 * A crossing's DISPLAY number — its position among standard tournaments in id
 * order, which is what `tournaments.name` ("Tournament #12") carries and what
 * web/src/format.ts's tournamentNo() parses back out.
 *
 * Deliberately NOT the row id, and the distinction is the whole point: `id` is
 * a single sequence shared by every kind, so each rehearsal (and, on DEMO=1,
 * each exhibit) consumes a number that no tournament ever wears. Production
 * had drifted to "Tournament #100" with only 88 tournaments in existence — a
 * count inflated by 13 Play-From-Here branches, which are not crossings and
 * which a player has no way to know about.
 *
 * The id stays the ADDRESS — `/t/:id/b/:no`, boards.tournament_id,
 * elo_history.tournament_id, origin_tournament_id — and this is only ever
 * presentation. Keeping the two apart is what lets rehearsals reuse the board
 * route for free (Analyze.tsx navigates a fresh branch straight to /t/:id) and
 * keeps every link ever shared valid. Putting the ordinal in the URL instead
 * would be actively unsafe: ordinals 1..N overlap the id space, so an old
 * link would resolve to a DIFFERENT tournament rather than 404.
 *
 * The ordinal is stable forever, which is what makes it safe to bake into a
 * stored name. It can only change if a standard row with a lower id is
 * deleted, and nothing deletes one: the only DELETE FROM tournaments in the
 * app is discardRehearsal (rehearsal rows only), and demo-seed's full wipe
 * runs on DEMO=1 databases that are recreated from scratch anyway. Creating
 * or discarding a rehearsal never moves a crossing's number.
 *
 * `id <= ?` rather than a bare COUNT(*) so this reads the same for a row
 * inserted out of created_at order (demo-seed backdates ambient tournaments;
 * ids still ascend), and so the runtime and the backfill migration below are
 * literally the same expression rather than two statements that agree today.
 */
const stmtCrossingOrdinal = db.prepare(
  `SELECT COUNT(*) AS n FROM tournaments WHERE kind = 'standard' AND id <= ?`,
);

export function crossingName(id: number): string {
  return `Tournament #${(stmtCrossingOrdinal.get(id) as { n: number }).n}`;
}

/**
 * Display order for the benchmark AI personas when scores tie: strongest
 * first (The Shark above The Regular above The Novice). Keyed on google_id —
 * the personas' stable identity (ai-players.ts); handles are display copy
 * and can be renamed. Humans (or unknown ids) rank 0, ahead of every
 * persona, preserving the "a human outranks a persona they tie with" rule.
 */
export function aiTieRank(googleId: string | null | undefined): number {
  switch (googleId) {
    case 'ai:expert':
      return 1;
    case 'ai:intermediate':
      return 2;
    case 'ai:beginner':
      return 3;
    default:
      return 0;
  }
}

export interface BoardRow {
  id: number;
  tournament_id: number;
  user_id: number;
  board_no: number;
  state: 'bidding' | 'playing' | 'done';
  calls: string;
  plays: string;
  bid_evals: string;
  contract: string | null;
  tricks_declarer: number | null;
  score_ns: number | null;
  /** plays[] index of the first server-played card of a resolved claim; NULL = no claim (or pre-migration board — re-derived by analyze.ts) */
  claimed_at_ply: number | null;
  updated_at: number;
}
