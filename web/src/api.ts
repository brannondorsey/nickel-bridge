/** Thin typed client for the server API. */

export interface Me {
  user: { id: number; name: string; picture: string | null; elo: number } | null;
  devAuth?: boolean;
  googleAuth?: boolean;
}

export interface BidMeaning {
  title: string;
  description: string;
  points?: string;
  shapePromise?: string;
  artificial?: boolean;
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
}

export interface TrickCard {
  seat: number;
  card: number;
}

export interface FieldEntry {
  userId: number;
  name: string;
  contract: string;
  scoreNS: number;
  pct: number;
  isMe: boolean;
}

export interface BoardResult {
  contractLabel: string;
  tricksDeclarer: number | null;
  scoreNS: number;
  pct: number;
  field: FieldEntry[];
  bidAccuracy: number | null;
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
  myTurn?: boolean;
  contract?: unknown;
  contractLabel?: string;
  declarer?: number;
  dummy?: number;
  watching?: boolean;
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
}

export interface Standing {
  userId: number;
  name: string;
  boardsDone: number;
  totalPct: number | null;
  complete: boolean;
  rank?: number;
}

export interface TournamentInfo {
  id: number;
  name: string;
  status: 'open' | 'closed';
  closesAt: number;
  myDone?: number;
  standings: Standing[];
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
  leaderboard: () =>
    request<{ leaderboard: { id: number; name: string; picture: string | null; elo: number; rated_tournaments: number; played_tournaments: number }[] }>(
      '/api/leaderboard',
    ),
};

// ---- shared card/call helpers (mirror @bridge/core conventions) ----

export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const STRAIN_SYMBOLS = ['♣', '♦', '♥', '♠', 'NT'];
export const SEAT_SHORT = ['N', 'E', 'S', 'W'];

export const cardSuit = (c: number) => Math.floor(c / 13);
export const cardRank = (c: number) => c % 13;
export const isRed = (c: number) => cardSuit(c) === 1 || cardSuit(c) === 2;
export const callDisplay = (call: number): string => {
  if (call === 0) return 'Pass';
  if (call === 1) return 'X';
  if (call === 2) return 'XX';
  const level = Math.floor((call - 3) / 5) + 1;
  return `${level}${STRAIN_SYMBOLS[(call - 3) % 5]}`;
};
export const makeBid = (level: number, strain: number) => 3 + (level - 1) * 5 + strain;

/** sort for display: ♠ ♥ ♣ ♦ alternating colors, descending ranks */
export function displaySort(hand: number[]): number[] {
  const suitOrder = [0, 1, 3, 2]; // ♠ ♥ ♣ ♦
  return [...hand].sort((a, b) => {
    const sa = suitOrder.indexOf(cardSuit(a));
    const sb = suitOrder.indexOf(cardSuit(b));
    if (sa !== sb) return sa - sb;
    return cardRank(b) - cardRank(a);
  });
}
