/** Thin typed client for the server API. */

/** ♣/♦/♥/♠, matching packages/core/src/medals.ts's tier order (4/25/100/500 tournaments). */
export type MedalSuit = 'c' | 'd' | 'h' | 's';

/**
 * The Home rail's medal progress (server/src/medals.ts), fully computed
 * server-side — the client only renders it. `target`/`pct`/`tournamentsRemaining`
 * are null/0 once every medal is earned (`target === null`).
 */
export interface MedalProgress {
  earned: MedalSuit[];
  target: MedalSuit | null;
  pct: number;
  tournamentsRemaining: number;
}

export interface Me {
  user: {
    id: number;
    handle: string | null;
    picture: string | null;
    elo: number;
    /** unix seconds when the first-crossing tour was completed or skipped; null = show it */
    onboardedAt: number | null;
    /** shown on /leaderboard to visitors without an account (settings: "Name on the ladder") */
    ladderListed: boolean;
    /** let the server fast-play a settled tail, rather than playing it out yourself (settings: "Settled tricks"); ignored on legacy tournaments, which always claim */
    autoClaim: boolean;
    /** show the post-call grading toast (settings: "Bid feedback") */
    bidFeedback: boolean;
    /** submit a bid on a second tap of the selected call, without pressing Bid (settings: "Double-tap to bid"); default false */
    doubleTapBid: boolean;
    /** how a completed trick leaves the table (settings: "Trick clearing") — 'auto' times out on its own, 'tap' holds until the trick area is tapped */
    trickClearMode: 'auto' | 'tap';
    /** where the trump suit sits once a trump contract is settled (settings: "Trump placement") — 'suit' is always ♠♥♦♣, 'left' promotes the trump block */
    trumpPlacement: 'suit' | 'left';
    /**
     * Opt in to features still being tried out before a general release —
     * nothing is gated behind it today. Off by default in production, on by
     * default on preview/demo deployments (settings: "Beta features"); see
     * the beta_features migration in server/src/db.ts.
     */
    betaFeatures: boolean;
    /**
     * Completed standard boards. Sent because Compare's entry points need to
     * know whether the VIEWER has a record worth comparing — on someone else's
     * profile the client has their board count but not its own.
     */
    boards: number;
    /** null only for a signed-out/non-human session; never applies to a real user's own /api/me */
    medals: MedalProgress | null;
  } | null;
  devAuth?: boolean;
  googleAuth?: boolean;
  /** demo mode (preview deployments): /scenarios gallery on, auto-splash off */
  demo?: boolean;
  /**
   * Completed boards both players need before Compare is offered. Served rather
   * than mirrored here, because DEMO=1 relaxes it (the seeder's bots never reach
   * the production floor) — a hardcoded copy would put the button on screens the
   * server then refuses. server/src/compare.ts's compareMin() is the authority.
   */
  compareMinBoards?: number;
  /**
   * The leaderboard's rated-tournament quota (server/src/tournaments.ts's
   * provisionalMin()). Sent because DEMO=1 relaxes it to 1 (from a
   * production 4) — the Home medal rail's club-tier copy uses this to know
   * whether "...to join the rankings" is still true rather than hardcoding
   * the production number. See MedalBar.tsx's doc comment.
   */
  provisionalMin?: number;
}

export interface BidMeaning {
  title: string;
  description: string;
  points?: string;
  shapePromise?: string;
  artificial?: boolean;
  /** partner may not pass: forcing for one round, or forcing to game */
  forcing?: 'one-round' | 'game';
  exact: boolean;
}

export interface AuctionEntry {
  seat: number;
  call: number;
  name: string;
  isHuman: boolean;
  meaning: BidMeaning | null;
}

export interface BidEval {
  call: number;
  bestCall: number;
  userProb: number;
  bestProb: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  score: number;
  /** the call matches a defined SAYC convention the hand satisfies (absent on old boards) */
  saycConsistent?: boolean;
  /** meaning of the robot's preferred call, for teaching copy (absent on old boards) */
  bestMeaning?: BidMeaning | null;
}

export interface TrickCard {
  seat: number;
  card: number;
}

interface FieldEntry {
  userId: number;
  handle: string;
  /** 'ai' = benchmark house player: a full field member, visually tagged HOUSE */
  kind: 'human' | 'ai';
  contract: string;
  scoreNS: number;
  pct: number;
  isMe: boolean;
}

/** One line of the duplicate-scoring receipt (mirror of @bridge/core ScoreLine). */
export interface ScoreLine {
  kind: 'odd-tricks' | 'overtricks' | 'undertricks' | 'game-bonus' | 'partscore-bonus' | 'slam-bonus' | 'insult-bonus';
  label: string;
  detail: string;
  /** Signed, from the DECLARING side's perspective. */
  amount: number;
}

export interface ScoreBreakdown {
  lines: ScoreLine[];
  vulnerable: boolean;
  total: number;
}

export interface BoardResult {
  contractLabel: string;
  tricksDeclarer: number | null;
  scoreNS: number;
  pct: number;
  field: FieldEntry[];
  bidAccuracy: number | null;
  /** Itemized scoring for the toll receipt; null on a pass-out. */
  breakdown: ScoreBreakdown | null;
}

interface Contract {
  level: number;
  strain: number;
  declarer: number;
  doubled?: boolean;
  redoubled?: boolean;
}

export interface BoardView {
  tournamentId: number;
  tournamentName: string;
  boardNo: number;
  totalBoards: number;
  state: 'bidding' | 'playing' | 'done';
  dealer: number;
  vul: { ns: boolean; ew: boolean };
  hand: number[];
  fullHand: number[];
  hcp: number;
  auction: AuctionEntry[];
  bidEvals: BidEval[];
  legalCalls?: number[];
  /** SAYC meaning per legal call (null = no convention entry), sent while bidding on my turn */
  legalCallMeanings?: Record<number, BidMeaning | null>;
  myTurn?: boolean;
  contract?: Contract;
  contractLabel?: string;
  declarer?: number;
  dummy?: number;
  flipped?: boolean;
  playingSeat?: number;
  currentTrick?: TrickCard[];
  completedTricks?: number;
  declarerTricks?: number;
  defenderTricks?: number;
  lastTrick?: TrickCard[] | null;
  dummyHand?: number[];
  dummyHcp?: number;
  handToPlay?: number;
  legalCards?: number[];
  result?: BoardResult;
  allHands?: number[][];
  playHistory?: TrickCard[][];
  /** true when this board completed via an automatic laydown claim, not full play-out */
  claimed?: boolean;
  /** present only when this board is a "Play From Here" rehearsal — never scored, see server/src/rehearsal.ts */
  rehearsal?: { originTournamentId: number; originBoardNo: number; branchPly: number };
  /** the origin board's own real result, sent alongside a FINISHED rehearsal's own `result` for the adjusted receipt's comparison */
  originResult?: BoardResult;
  /** what this line's score would have earned against the origin board's real field (substituted, never appended) — null if that field has too few entrants for a pct to mean anything */
  lineMatchpoints?: number | null;
}

/** One "Play From Here" attempt on a board — see server/src/rehearsal.ts */
export interface RehearsalSummary {
  tournamentId: number;
  boardNo: number;
  branchPly: number;
  state: 'playing' | 'done';
  createdAt: number;
  contractLabel: string | null;
  scoreNS: number | null;
}

/**
 * The Analyze review's verdicts, mirrored from server/src/analyze.ts —
 * pre-computed server-side and only DRAWN here (the Compare precedent: a
 * client that re-derived verdicts would eventually disagree with a cached
 * one). MP figures from these types render only inside the Analyze screen.
 */
export interface AnalysisPly {
  ply: number;
  trick: number;
  seat: number;
  card: number;
  /** tricks the human's side lost at this card per the DD trace (> 0 always) */
  ddLoss: number;
  cfTricksDeclarer: number;
  cfScoreNS: number;
  cfPct: number | null;
  mpCost: number | null;
  /** only present for a genuine, chargeable fault — an excused candidate (the
   *  sampled engine would also have played the card) never reaches the
   *  client at all; see server/src/analyze.ts's stage-3 doc comment */
  sampled: { bestCard: number; deficit: number; grade: 0 | 1 | 2 | 3 } | null;
}

export interface AnalysisMoment {
  kind: 'play' | 'bid' | 'combined';
  ply?: number;
  trick?: number;
  card?: number;
  grade?: 0 | 1 | 2 | 3;
  callIndex?: number;
  call?: number;
  /** combined moments only: the plays[] indices of the contributing plies, ascending */
  plies?: number[];
  mpCost: number;
}

export interface AnalysisCall {
  callIndex: number;
  call: number;
  bestCall: number;
  cf: {
    calls: number[];
    contractLabel: string;
    ddTricks: number | null;
    scoreNS: number;
    cfPct: number | null;
    mpGain: number | null;
  } | null;
}

export interface AnalysisPar {
  parScore: number;
  parContracts: string[];
  calls: AnalysisCall[];
}

export interface AnalysisView {
  version: number;
  boardNo: number;
  contract: Contract | null;
  claimedAtPly: number | null;
  singleField: boolean;
  /** the field snapshot the verdicts were computed against, refreshed against the live
   * field on every request (never frozen at first compute — see refreshMatchpointLayer) */
  fieldScores: number[];
  myIndex: number;
  actualPct: number | null;
  ddTricks: number[] | null;
  plies: AnalysisPly[];
  moments: AnalysisMoment[];
  setAside: number;
  par: AnalysisPar | null;
  /** MOMENT_FLOOR — the mpCost figures are refreshed against the live field
   *  per request while stage 3's floor selection ran at first open, so the
   *  caption for a drifted unjudged ply needs the floor to compare against */
  momentFloor: number;
}

interface Standing {
  userId: number;
  handle: string;
  /** 'ai' rows are the benchmark house players — they rank and count as players, but never rate */
  kind: 'human' | 'ai';
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
  /**
   * This player's rating swing from this crossing, in points. Sent by the
   * tournament detail endpoint only (absent on the lobby list); `null` there
   * means the crossing never rated them — a house persona, an unfinished
   * field, or a crossing only one human completed.
   */
  eloDelta?: number | null;
}

interface MyBoardSummary {
  no: number;
  state: 'bidding' | 'playing' | 'done';
  contractLabel: string | null;
  scoreNS: number | null;
  pct: number | null;
}

export interface TournamentInfo {
  id: number;
  name: string;
  myDone?: number;
  createdAt?: number;
  /** unix seconds of my last completed board, null if I've finished none */
  myLastPlayedAt?: number | null;
  /** my rating change from this tournament, null while it hasn't rated */
  myEloDelta?: { before: number; after: number } | null;
  /** my started boards (detail endpoint only); unstarted boards are absent */
  myBoards?: MyBoardSummary[];
  standings: Standing[];
}

interface StatPoint {
  tournamentId: number;
  tournamentName: string;
  finishedAt: number | null;
}

/** Auction-role bucket for the bidding ledger (server: core's bidCategory). */
export type BidTypeKey = 'opening' | 'response' | 'rebid' | 'overcall' | 'double' | 'pass';

/** One UTC calendar day with at least one completed board (server: stats.ts's dailyBoards). */
export interface DailyBoardCount {
  /** UTC calendar day, 'YYYY-MM-DD' */
  date: string;
  count: number;
}

/** One entry in the RIVALRIES panel — head-to-head record vs. a shared-field opponent (server: stats.ts's Rival). */
export interface Rival {
  userId: number;
  handle: string;
  /** 'ai' = one of the benchmark house players (ai-players.ts) */
  kind: 'human' | 'ai';
  shared: number;
  record: { ahead: number; behind: number; tied: number };
  /** this rival's completed boards — decides whether a Compare link would land somewhere real */
  boards: number;
}

/** Named-convention bucket for the convention ledger (server: core's ConventionFamily). */
export type ConventionKey =
  | 'stayman'
  | 'jacobyTransfer'
  | 'blackwood'
  | 'gerber'
  | 'weakTwo'
  | 'negativeDouble'
  | 'michaels';

export interface PlayerStats {
  /** 'ai' = one of the benchmark house players (ai-players.ts) */
  user: { id: number; handle: string; picture: string | null; elo: number; createdAt: number; kind: 'human' | 'ai' };
  totals: {
    boardsCompleted: number;
    tournamentsPlayed: number;
    tournamentsCompleted: number;
    /** loyalty medals actually earned (packages/core/src/medals.ts) — always [] for house/AI profiles */
    earnedMedals: MedalSuit[];
    /** longest run of consecutive UTC calendar days with >=1 completed board (server/src/stats.ts) */
    streakDays: number;
    currentElo: number;
    peakElo: number;
    avgPct: number | null;
    bestPct: { pct: number; tournamentName: string; tournamentId: number } | null;
    /**
     * Boards taken outright — full matchpoints against everyone who has played
     * that deal (server/src/stats.ts). `boardsCompleted` is the denominator;
     * `latest` deep-links the tile to the most recent one.
     */
    tops: { count: number; latest: { tournamentId: number; boardNo: number } | null };
    avgBidAccuracy: number | null;
    gradeCounts: { excellent: number; good: number; fair: number; poor: number };
    declarer: { boards: number; made: number };
    defense: { boards: number; beat: number };
    passedOut: number;
    /** rating change since the start of the current UTC month; null when unrated */
    monthlyEloDelta: number | null;
  };
  /** signed histogram of tricks made vs. contract, declaring boards only — buckets clip at ±3 */
  trickDelta: {
    buckets: { delta: -3 | -2 | -1 | 0 | 1 | 2 | 3; count: number }[];
    boards: number;
    avgDelta: number | null;
  };
  percentiles: {
    elo: number | null;
    avgPct: number | null;
    bidAccuracy: number | null;
    /** declaring-side make-rate percentile (server/src/stats.ts) */
    declaring: number | null;
    ratedPlayers: number;
    activePlayers: number;
    /** size of the declaring-rate comparison pool (players with at least one declaring board) */
    declaringPlayers: number;
  };
  eloSeries: (StatPoint & { elo: number })[];
  pctSeries: (StatPoint & { pct: number; boards: number; fieldSize: number })[];
  accuracySeries: (StatPoint & { accuracy: number | null; calls: number })[];
  /** graded calls by auction role, ranked best to worst by satisfactory-or-better share */
  bidTypes: { category: BidTypeKey; total: number; satisfactory: number }[];
  /** graded calls that were a named convention, by which one (server: conventionFamily) */
  conventions: { family: ConventionKey; total: number; satisfactory: number }[];
  /** declaring-side contract mix: partscore/game/slam + doubled/redoubled + strain family (server/src/stats.ts) */
  contractMix: {
    partscore: { boards: number; made: number };
    game: { boards: number; made: number };
    slam: { boards: number; made: number };
    doubled: { boards: number; made: number };
    strains: { notrump: number; major: number; minor: number };
  };
  /** completed boards by UTC day, sparse, ascending — see server's stats.ts doc comment */
  dailyBoards: DailyBoardCount[];
  /** other players ranked by shared-tournament count, most-crossed-paths first (max RIVAL_TOP_N = 10) */
  rivals: Rival[];
}

/**
 * Compare (server/src/compare.ts): the viewer's record beside another player's.
 *
 * Every judged row arrives with its verdict already decided. The client draws
 * `margin`/`gate`/`fullTilt` and prints the figures; it deliberately does not
 * re-derive any statistics, because the error model differs per measure (a rate
 * is binomial with an Agresti-Coull adjustment, bid accuracy is the mean of a
 * four-point score) and two implementations of that would drift.
 */
/**
 * Fallback floor for Compare's entry points, used only until `/api/me` has
 * answered. The served `me.compareMinBoards` is the authority — see the note on
 * that field — so this is deliberately the PRODUCTION value: erring toward
 * hiding a door is better than showing one the server will refuse.
 */
export const COMPARE_MIN_BOARDS_FALLBACK = 16;

export type CompareVerdict = 'you' | 'them' | 'level' | 'aside';
export type CompareAsideReason = 'thin' | 'provisional' | 'no-data';
export type ComparePanel = 'headline' | 'bidType' | 'convention' | 'contract';

export interface CompareMeasure {
  key: string;
  label: string;
  panel: ComparePanel;
  a: number | null;
  b: number | null;
  unit: 'elo' | 'pct' | 'pct1';
  margin: number;
  /** the threshold the margin must clear to be called, same units; null when the error is unbounded (always an `aside` row) */
  gate: number | null;
  fullTilt: number;
  verdict: CompareVerdict;
  reason?: CompareAsideReason;
  samples: [number, number];
}

export interface CompareContextRow {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  unit: 'elo' | 'pct' | 'pct1' | 'count' | 'delta';
}

/** Head-to-head between the pair, or between one of them and a house persona. */
export interface PairRecord {
  shared: number;
  ahead: number;
  behind: number;
  tied: number;
  /** most recent crossings, oldest first — a window on the record, not the whole of it */
  sequence: ('you' | 'them' | 'level')[];
}

export interface CompareSide {
  id: number;
  handle: string;
  picture: string | null;
  kind: 'human' | 'ai';
  boards: number;
}

export interface CompareView {
  you: CompareSide;
  them: CompareSide;
  /** false when either record is under `minBoards`; everything below is then empty */
  eligible: boolean;
  minBoards: number;
  /** null when the two have never shared a crossing — `commonGround` stands in */
  headToHead: PairRecord | null;
  commonGround: { userId: number; handle: string; you: PairRecord; them: PairRecord }[] | null;
  measures: CompareMeasure[];
  context: CompareContextRow[];
  tally: { you: number; them: number; level: number; aside: number };
}

/** A demo-mode gallery exhibit (see server/src/scenarios.ts). */
export interface DemoScenario {
  id: string;
  label: string;
  description: string;
  category: string;
  /**
   * Set only on the exhibit that needs the board moved on behind the tester
   * (server/src/scenarios.ts). Scenarios.tsx schedules api.demoDesync this
   * many ms after entering — the one exhibit whose state is produced on the
   * client rather than by the recipe.
   */
  desyncAfterMs?: number;
}

/**
 * The activity feed's raw material (server/src/activity.ts).
 *
 * These arrive as flat, ungrouped events carrying UTC unix seconds, because
 * the feed groups by the VIEWER's calendar day and time of day and the server
 * has no timezone for anyone. pages/activityFeed.ts does that grouping.
 */
export type ActivityEvent =
  | { kind: 'board'; userId: number; at: number }
  | { kind: 'joined'; userId: number; at: number }
  | {
      kind: 'crossing';
      userId: number;
      at: number;
      tournamentId: number;
      tournamentName: string;
      pct: number;
      rank: number;
      of: number;
      /** null when the tournament rated nobody (< 2 human finishers) — never 0 */
      eloDelta: number | null;
    }
  | {
      kind: 'milestone';
      userId: number;
      at: number;
      milestone: 'first-crossing' | 'entered-rankings' | 'peak-rating';
      /** the new rating, on 'peak-rating' only */
      value?: number;
    };

export interface ActivityResponse {
  /** window start, unix seconds — a day wider than the 7 the feed renders */
  since: number;
  /** every user id referenced by an event; keys are stringified by JSON */
  players: Record<string, { handle: string; picture: string | null }>;
  events: ActivityEvent[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<Me>('/api/me'),
  devLogin: (name: string) => request<{ ok: boolean }>('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) }),
  setHandle: (handle: string) =>
    request<{ user: Me['user'] }>('/api/handle', { method: 'POST', body: JSON.stringify({ handle }) }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  setOnboarded: () => request<{ ok: boolean }>('/api/me/onboarded', { method: 'POST' }),
  /** Partial update of the account-backed settings; absent keys are left alone. */
  setPrefs: (prefs: {
    ladderListed?: boolean;
    autoClaim?: boolean;
    bidFeedback?: boolean;
    betaFeatures?: boolean;
    doubleTapBid?: boolean;
    trickClearMode?: 'auto' | 'tap';
    trumpPlacement?: 'suit' | 'left';
  }) =>
    request<{
      ladderListed: boolean;
      autoClaim: boolean;
      bidFeedback: boolean;
      betaFeatures: boolean;
      doubleTapBid: boolean;
      trickClearMode: 'auto' | 'tap';
      trumpPlacement: 'suit' | 'left';
    }>('/api/me/prefs', { method: 'POST', body: JSON.stringify(prefs) }),
  play: () => request<{ tournamentId: number; boardNo: number }>('/api/play', { method: 'POST' }),
  tournaments: () => request<{ tournaments: TournamentInfo[] }>('/api/tournaments'),
  tournament: (id: number) => request<TournamentInfo>(`/api/tournaments/${id}`),
  board: (tid: number, no: number) => request<BoardView>(`/api/tournaments/${tid}/boards/${no}`),
  call: (tid: number, no: number, call: number) =>
    request<{ evaluation: BidEval; board: BoardView }>(`/api/tournaments/${tid}/boards/${no}/call`, {
      method: 'POST',
      body: JSON.stringify({ call }),
    }),
  playCard: (tid: number, no: number, card: number) =>
    request<{ board: BoardView }>(`/api/tournaments/${tid}/boards/${no}/play`, {
      method: 'POST',
      body: JSON.stringify({ card }),
    }),
  /** Analyze verdicts for a finished board; par=true adds stage 4 (the crossing/auction lenses) */
  analysis: (tid: number, no: number, par: boolean) =>
    request<AnalysisView>(`/api/tournaments/${tid}/boards/${no}/analysis${par ? '?par=1' : ''}`),
  /** Launch a "Play From Here" rehearsal branching at `ply` (a plays[] index — see AnalysisMoment/AnalysisPly) */
  rehearse: (tid: number, no: number, ply: number) =>
    request<{ tournamentId: number; boardNo: number }>(`/api/tournaments/${tid}/boards/${no}/rehearse`, {
      method: 'POST',
      body: JSON.stringify({ ply }),
    }),
  /** Every rehearsal attempt on this origin board, newest first, uncapped */
  rehearsals: (tid: number, no: number) =>
    request<{ rehearsals: RehearsalSummary[] }>(`/api/tournaments/${tid}/boards/${no}/rehearsals`),
  /** Delete one rehearsal attempt outright — the escape hatch beside rehearse's own same-ply resume */
  discardRehearsal: (tid: number, no: number, rehearsalId: number) =>
    request<{ ok: boolean }>(`/api/tournaments/${tid}/boards/${no}/rehearsals/${rehearsalId}`, {
      method: 'DELETE',
    }),
  playerStats: (id: number) => request<PlayerStats>(`/api/users/${id}/stats`),
  compare: (id: number) => request<CompareView>(`/api/compare/${id}`),
  // demo mode only (404 elsewhere): the /scenarios gallery
  demoScenarios: () =>
    request<{
      scenarios: DemoScenario[];
      newCrosserId: number;
      richProfileId: number;
      /** a seeded bot the Inspector has never shared a field with — the Compare "common ground" exhibit */
      strangerId: number;
      collisionHandle: string;
    }>(
      '/api/demo/scenarios',
    ),
  runDemoScenario: (id: string) =>
    request<{ tournamentId: number; boardNo: number }>(`/api/demo/scenarios/${id}`, { method: 'POST' }),
  /** demo only: play one card on your own board, as a second tab of yours would */
  demoDesync: (tournamentId: number, boardNo: number) =>
    request<{ advanced: boolean }>('/api/demo/desync', {
      method: 'POST',
      body: JSON.stringify({ tournamentId, boardNo }),
    }),
  resetDemo: () => request<{ ok: boolean }>('/api/demo/reset', { method: 'POST' }),
  leaderboard: () =>
    request<{
      leaderboard: {
        id: number;
        handle: string;
        picture: string | null;
        elo: number;
        rated_tournaments: number;
        played_tournaments: number;
        /**
         * Rank movement over the last day and the last week — rank then minus
         * rank now, so positive is a climb. Both windows arrive together so the
         * ladder's switch costs no round trip.
         *
         * Ranked over the visible ladder only, which is what makes them
         * readable against the ranks beside them. `null` means this player was
         * not ON the ladder at that cutoff, so there is no position to have
         * moved from — distinct from 0, "held station", even though the display
         * collapses both to an em dash.
         */
        movement1d: number | null;
        movement7d: number | null;
      }[];
      /**
       * The benchmark house personas — beside the ladder, never on it (they
       * don't rate, so there's nothing to rank them by). Their profiles are
       * the only ones readable without an account, so this is how a
       * signed-out visitor finds one.
       */
      house: { id: number; handle: string; picture: string | null }[];
      /** rated tournaments needed before a player shows up in `leaderboard` */
      provisionalMin: number;
      /**
       * The signed-in user's own rated-tournament count, even if below
       * provisionalMin — null when nobody is signed in. The ladder itself is
       * public, so this is the one field that has an anonymous case, and it
       * has to be distinguishable from a real 0: 0 means "you have played
       * nothing yet", null means there is no you.
       */
      yourRatedTournaments: number | null;
    }>('/api/leaderboard'),
  activity: () => request<ActivityResponse>('/api/activity'),
};

// ---- shared card/call helpers (mirror @bridge/core conventions) ----

export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const STRAIN_SYMBOLS = ['♣', '♦', '♥', '♠', 'NT'];
export const SEAT_SHORT = ['N', 'E', 'S', 'W'];

export const cardSuit = (c: number) => Math.floor(c / 13);
export const cardRank = (c: number) => c % 13;
/** four-color deck: ♠ black, ♥ red, ♦ yellow, ♣ green */
const SUIT_CLASSES = ['suit-s', 'suit-h', 'suit-d', 'suit-c'];
export const suitClass = (suit: number) => SUIT_CLASSES[suit];
/** strain (♣♦♥♠NT bid order) → color class */
export const strainClass = (strain: number) => (strain === 4 ? 'suit-nt' : SUIT_CLASSES[3 - strain]);
/** a leveled bid (1♣–7NT) rather than Pass/X/XX */
export const isBid = (call: number) => call >= 3;
/** contract level (1–7) of a leveled bid — meaningless for Pass/X/XX */
export const bidLevel = (call: number) => Math.floor((call - 3) / 5) + 1;
export const callDisplay = (call: number): string => {
  if (call === 0) return 'Pass';
  if (call === 1) return 'X';
  if (call === 2) return 'XX';
  return `${bidLevel(call)}${STRAIN_SYMBOLS[(call - 3) % 5]}`;
};
export const makeBid = (level: number, strain: number) => 3 + (level - 1) * 5 + strain;

/**
 * Standard duplicate dealer/vulnerability cycle — a pure function of board
 * number, mirrored from @bridge/core boardConditions so tournament screens can
 * label boards without fetching each one.
 */
export function boardConditions(boardNo: number): { dealer: number; vul: { ns: boolean; ew: boolean } } {
  const dealer = (boardNo - 1) % 4;
  const VULS = [
    { ns: false, ew: false },
    { ns: true, ew: false },
    { ns: false, ew: true },
    { ns: true, ew: true },
  ];
  const idx = (boardNo - 1 + Math.floor((boardNo - 1) / 4)) % 4;
  return { dealer, vul: VULS[idx] };
}

/**
 * The suits, in the order a hand is laid out: ♠ ♥ ♦ ♣ normally, and with the
 * trump suit promoted to the front when the reader has asked for that
 * ("Trump placement · LEFT SIDE", users.trump_placement).
 *
 * The other three keep their relative order behind it rather than rotating —
 * a player reads the fan by colour as much as by glyph, and rotating would
 * move ♥ and ♦ next to each other on two contracts in four. Pass null (no
 * trump suit, a no-trump contract, or the preference off) for plain suit
 * order. One helper rather than three copies because the fan, the dummy rail
 * and Analyze's suit lines all have to agree — a hand that reads trump-left
 * in the fan and ♠♥♦♣ in the rail beside it is worse than either alone.
 */
export function suitDisplayOrder(trump?: number | null): number[] {
  const suits = [0, 1, 2, 3];
  if (trump === null || trump === undefined) return suits;
  return [trump, ...suits.filter((s) => s !== trump)];
}

/**
 * Sort for display: suits per suitDisplayOrder above (each has its own
 * color), descending ranks within each.
 *
 * Note what `trump` does NOT change: the cards themselves, which of them are
 * legal, or anything the server was told. This is the order they are drawn
 * in and nothing else, so two players on the same board holding opposite
 * preferences still hold the same hand.
 */
export function displaySort(hand: number[], trump?: number | null): number[] {
  const rank = suitDisplayOrder(trump);
  return [...hand].sort((a, b) => {
    if (cardSuit(a) !== cardSuit(b)) return rank.indexOf(cardSuit(a)) - rank.indexOf(cardSuit(b));
    return cardRank(b) - cardRank(a);
  });
}

/**
 * The suit whose block leads a hand, or null for plain ♠♥♦♣ — the one place
 * the preference, the contract and the strain encoding meet.
 *
 * `strain` counts in BID order (0=♣ 1=♦ 2=♥ 3=♠ 4=NT) and suits count the
 * other way (0=♠ 1=♥ 2=♦ 3=♣), so the conversion is `3 - strain`; getting
 * that backwards promotes the wrong suit rather than failing, which is why
 * it lives here once instead of at each call site. No-trump has no trump
 * suit, an unsettled auction has no contract, and the default preference
 * leaves every hand in suit order — all three answer null.
 */
export function trumpForDisplay(
  contract: { strain: number } | undefined,
  placement: 'suit' | 'left' | undefined,
): number | null {
  if (placement !== 'left' || !contract) return null;
  return contract.strain === 4 ? null : 3 - contract.strain;
}
