/** Thin typed client for the server API. */

export interface Me {
  user: { id: number; handle: string | null; picture: string | null; elo: number } | null;
  devAuth?: boolean;
  googleAuth?: boolean;
  /** demo mode (preview deployments): /scenarios gallery on, auto-splash off */
  demo?: boolean;
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

interface BoardResult {
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
}

interface Standing {
  userId: number;
  handle: string;
  /** 'ai' rows are the benchmark house players — they rank and count as pairs, but never rate */
  kind: 'human' | 'ai';
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
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

export interface PlayerStats {
  /** 'ai' = one of the benchmark house players (ai-players.ts) */
  user: { id: number; handle: string; picture: string | null; elo: number; createdAt: number; kind: 'human' | 'ai' };
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
    /** rating change since the start of the current UTC month; null when unrated */
    monthlyEloDelta: number | null;
  };
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

/** A demo-mode gallery exhibit (see server/src/scenarios.ts). */
export interface DemoScenario {
  id: string;
  label: string;
  description: string;
  category: string;
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
  playerStats: (id: number) => request<PlayerStats>(`/api/users/${id}/stats`),
  // demo mode only (404 elsewhere): the /scenarios gallery
  demoScenarios: () =>
    request<{ scenarios: DemoScenario[]; newCrosserId: number; richProfileId: number; collisionHandle: string }>(
      '/api/demo/scenarios',
    ),
  runDemoScenario: (id: string) =>
    request<{ tournamentId: number; boardNo: number }>(`/api/demo/scenarios/${id}`, { method: 'POST' }),
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
        /** rank movement since the previous rated tournament; null without a prior snapshot */
        movement: number | null;
      }[];
    }>('/api/leaderboard'),
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
export const callDisplay = (call: number): string => {
  if (call === 0) return 'Pass';
  if (call === 1) return 'X';
  if (call === 2) return 'XX';
  const level = Math.floor((call - 3) / 5) + 1;
  return `${level}${STRAIN_SYMBOLS[(call - 3) % 5]}`;
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

/** sort for display: ♠ ♥ ♦ ♣ (each suit has its own color), descending ranks */
export function displaySort(hand: number[]): number[] {
  return [...hand].sort((a, b) => {
    if (cardSuit(a) !== cardSuit(b)) return cardSuit(a) - cardSuit(b);
    return cardRank(b) - cardRank(a);
  });
}
