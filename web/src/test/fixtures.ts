/**
 * Typed API fixtures for web unit tests.
 *
 * Card ints follow @bridge/core: card = suit*13 + rank, suit 0=♠ 1=♥ 2=♦ 3=♣,
 * rank 0..12 = 2..A. Calls: 0=Pass 1=X 2=XX, bid = 3 + (level-1)*5 + strain
 * (strain 0=♣ 1=♦ 2=♥ 3=♠ 4=NT). Deals here are hand-built to be internally
 * consistent (52 distinct cards, legal auctions) but are not real dealt boards.
 */
import type {
  AuctionEntry,
  BidEval,
  BidMeaning,
  BoardView,
  Me,
  PlayerStats,
  TournamentInfo,
} from '../api';
import { makeBid } from '../api';

// ---- users ----

export const meFixture: Me = {
  user: { id: 1, handle: 'Margaret', picture: null, elo: 1487 },
  devAuth: true,
  googleAuth: true,
};

export const meNoHandle: Me = { ...meFixture, user: { ...meFixture.user!, handle: null } };
export const meLoggedOut: Me = { user: null, devAuth: true, googleAuth: true };

// ---- hands (S = the human's hand from the design prototype: 12 HCP) ----

const S = 0; // ♠ suit index for card()
const H = 1;
const D = 2;
const C = 3;
const R: Record<string, number> = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8, J: 9, Q: 10, K: 11, A: 12 };
const card = (suit: number, rank: string) => suit * 13 + R[rank];

export const southHand = [
  card(S, 'A'), card(S, 'Q'), card(S, '10'),
  card(H, 'K'), card(H, 'J'), card(H, '9'), card(H, '6'), card(H, '3'),
  card(D, '8'), card(D, '2'),
  card(C, 'Q'), card(C, '9'), card(C, '5'),
];

export const northHand = [
  card(S, 'K'), card(S, 'J'), card(S, '4'),
  card(H, '8'), card(H, '2'),
  card(D, 'A'), card(D, 'Q'), card(D, '7'), card(D, '4'),
  card(C, 'K'), card(C, '8'), card(C, '6'), card(C, '3'),
];

export const westHand = [
  card(S, '8'), card(S, '3'),
  card(H, 'Q'), card(H, '10'), card(H, '7'), card(H, '5'),
  card(D, 'K'), card(D, 'J'), card(D, '9'),
  card(C, 'J'), card(C, '10'), card(C, '7'), card(C, '2'),
];

const dealt = new Set([...southHand, ...northHand, ...westHand]);
export const eastHand = Array.from({ length: 52 }, (_, c) => c).filter((c) => !dealt.has(c));

/** allHands is indexed by seat: N, E, S, W */
export const allHands = [northHand, eastHand, southHand, westHand];

// ---- auction: dealer N; N Pass, E Pass, S 1♥, W Pass, N 1NT, E Pass → S to call ----

export const meaning1H: BidMeaning = {
  title: 'Opening, one of a major',
  description: 'Five or more hearts with opening values.',
  points: '13–21 HCP',
  shapePromise: '5+ hearts',
  exact: true,
};

export const meaning2H: BidMeaning = {
  title: 'Rebid, invitational',
  description:
    "Shows a long heart suit worth rebidding and invitational values opposite partner's 1NT. Partner passes with a minimum.",
  points: '10–12 HCP',
  shapePromise: '6+ hearts',
  exact: true,
};

const bid1H = makeBid(1, 2);
const bid1NT = makeBid(1, 4);
export const bid2H = makeBid(2, 2);
const entry = (seat: number, callNo: number, name: string, meaning: BidMeaning | null = null): AuctionEntry => ({
  seat,
  call: callNo,
  name,
  isHuman: seat === 2,
  meaning,
});

export const biddingAuction: AuctionEntry[] = [
  entry(0, 0, 'Pass'),
  entry(1, 0, 'Pass'),
  entry(2, bid1H, '1♥', meaning1H),
  entry(3, 0, 'Pass'),
  entry(0, bid1NT, '1NT', {
    title: "Partner's response, 1NT",
    description: 'A catch-all response: 6–9 points, no fit yet.',
    points: '6–9 HCP',
    exact: false,
  }),
  entry(1, 0, 'Pass'),
];

const legalCalls = [0, ...Array.from({ length: 30 }, (_, i) => i + 8)]; // Pass + 2♣..7NT

const base = {
  tournamentId: 12,
  tournamentName: 'Tournament #12',
  boardNo: 2,
  totalBoards: 4,
  dealer: 0,
  vul: { ns: true, ew: false },
  hand: southHand,
  fullHand: southHand,
  hcp: 12,
  auction: biddingAuction,
  bidEvals: [] as BidEval[],
};

export const boardBidding: BoardView = {
  ...base,
  state: 'bidding',
  myTurn: true,
  legalCalls,
  legalCallMeanings: { [bid2H]: meaning2H, 8: null },
};

export const boardBiddingRobots: BoardView = {
  ...base,
  state: 'bidding',
  myTurn: false,
  auction: biddingAuction.slice(0, 3),
};

// ---- play: 4♠ by S, trick 5, spades led ----

const playedFromSouth = [card(H, '3'), card(H, '6'), card(D, '2'), card(C, '5')];
const southRemaining = southHand.filter((c) => !playedFromSouth.includes(c));

export const boardPlaying: BoardView = {
  ...base,
  state: 'playing',
  myTurn: true,
  hand: southRemaining,
  contractLabel: '4♠ by S',
  contract: { level: 4, strain: 3, declarer: 2, doubled: false, redoubled: false },
  declarer: 2,
  dummy: 0,
  currentTrick: [
    { seat: 3, card: card(S, '3') },
    { seat: 0, card: card(S, '4') },
    { seat: 1, card: card(S, '2') },
  ],
  completedTricks: 4,
  declarerTricks: 3,
  defenderTricks: 1,
  lastTrick: null,
  dummyHand: northHand.filter((c) => ![card(H, '2'), card(D, '4'), card(C, '3'), card(C, '6')].includes(c)),
  dummyHcp: 13,
  handToPlay: 2,
  legalCards: [card(S, 'A'), card(S, 'Q'), card(S, '10')],
};

/** partner (N) declared — human plays the North hand; South is dummy */
export const boardPlayingFlipped: BoardView = {
  ...base,
  state: 'playing',
  myTurn: true,
  flipped: true,
  playingSeat: 0,
  hand: northHand,
  contractLabel: '4♥ by N',
  contract: { level: 4, strain: 2, declarer: 0, doubled: false, redoubled: false },
  declarer: 0,
  dummy: 2,
  currentTrick: [],
  completedTricks: 0,
  declarerTricks: 0,
  defenderTricks: 0,
  lastTrick: null,
  dummyHand: southHand,
  dummyHcp: 12,
  hcp: 13,
  handToPlay: 0,
  legalCards: northHand,
};

/** human declares and it is dummy's turn: the dummy fan is the interactive one */
export const boardPlayingDummyTurn: BoardView = {
  ...boardPlaying,
  currentTrick: [],
  handToPlay: 0,
  legalCards: boardPlaying.dummyHand!,
};

/** West declares 3NT, East is dummy — an opponent's hand, shown as a rail */
export const boardPlayingEastDummy: BoardView = {
  ...boardPlaying,
  contractLabel: '3NT by W',
  contract: { level: 3, strain: 4, declarer: 3, doubled: false, redoubled: false },
  declarer: 3,
  dummy: 1,
  dummyHand: eastHand,
  dummyHcp: 10,
};

/** East declares 3NT, West is dummy — same rail, mirrored to the left */
export const boardPlayingWestDummy: BoardView = {
  ...boardPlaying,
  contractLabel: '3NT by E',
  contract: { level: 3, strain: 4, declarer: 1, doubled: false, redoubled: false },
  declarer: 1,
  dummy: 3,
  dummyHand: westHand,
  dummyHcp: 8,
};

// ---- done ----

export const bidEvalsFixture: BidEval[] = [
  { call: bid1H, bestCall: bid1H, userProb: 0.81, bestProb: 0.81, grade: 'excellent', score: 1 },
  {
    call: bid2H,
    bestCall: makeBid(3, 2),
    userProb: 0.3,
    bestProb: 0.55,
    grade: 'good',
    score: 0.7,
    saycConsistent: true,
    bestMeaning: {
      title: 'Limit raise',
      description: 'Invitational jump raise: 3+ card support and 10–12 points.',
      exact: true,
    },
  },
  { call: makeBid(4, 3), bestCall: makeBid(4, 3), userProb: 0.72, bestProb: 0.72, grade: 'fair', score: 0.4 },
  { call: 0, bestCall: makeBid(4, 4), userProb: 0.05, bestProb: 0.6, grade: 'poor', score: 0.05 },
];

export const boardDone: BoardView = {
  ...base,
  state: 'done',
  bidEvals: bidEvalsFixture,
  contractLabel: '4♠ by S',
  declarer: 2,
  dummy: 0,
  allHands,
  result: {
    contractLabel: '4♠ by S',
    tricksDeclarer: 10,
    scoreNS: 620,
    pct: 58,
    bidAccuracy: 89,
    breakdown: {
      lines: [
        { kind: 'odd-tricks', label: 'Odd tricks', detail: '4 × 30', amount: 120 },
        { kind: 'game-bonus', label: 'Game bonus', detail: 'vulnerable', amount: 500 },
      ],
      vulnerable: true,
      total: 620,
    },
    field: [
      { userId: 7, handle: 'Alice', kind: 'human', contract: '4♠+1 by S', scoreNS: 650, pct: 83, isMe: false },
      { userId: 1, handle: 'Margaret', kind: 'human', contract: '4♠ by S', scoreNS: 620, pct: 58, isMe: true },
      { userId: 8, handle: 'Bob', kind: 'human', contract: '3♠+1 by S', scoreNS: 170, pct: 33, isMe: false },
      { userId: 9, handle: 'Cara', kind: 'human', contract: '4♠-1 by S', scoreNS: -100, pct: 8, isMe: false },
      { userId: 90, handle: 'The Shark', kind: 'ai', contract: '4♠-2 by S', scoreNS: -200, pct: 6, isMe: false },
    ],
  },
};

export const boardDoneLow: BoardView = {
  ...boardDone,
  result: {
    ...boardDone.result!,
    pct: 33,
    scoreNS: -100,
    contractLabel: '4♠-1 by S',
    tricksDeclarer: 9,
    breakdown: {
      lines: [{ kind: 'undertricks', label: 'Down one', detail: '100, vulnerable', amount: -100 }],
      vulnerable: true,
      total: -100,
    },
  },
};

// ---- tournaments ----

export const tournamentInProgress: TournamentInfo = {
  id: 12,
  name: 'Tournament #12',
  myDone: 1,
  createdAt: 1_781_000_000,
  myLastPlayedAt: 1_781_050_000,
  myEloDelta: null,
  myBoards: [
    { no: 1, state: 'done', contractLabel: '4♠ by S', scoreNS: 620, pct: 58 },
    { no: 2, state: 'bidding', contractLabel: null, scoreNS: null, pct: null },
  ],
  standings: [
    { userId: 7, handle: 'Alice', kind: 'human', boardsDone: 4, totalPct: 83, complete: true, rank: 1 },
    { userId: 90, handle: 'The Shark', kind: 'ai', boardsDone: 4, totalPct: 66, complete: true, rank: 2 },
    { userId: 1, handle: 'Margaret', kind: 'human', boardsDone: 1, totalPct: 58, complete: false },
    { userId: 8, handle: 'Bob', kind: 'human', boardsDone: 2, totalPct: 33, complete: false },
  ],
};

export const tournamentComplete: TournamentInfo = {
  id: 11,
  name: 'Tournament #11',
  myDone: 4,
  createdAt: 1_780_400_000,
  myLastPlayedAt: 1_780_500_000,
  myEloDelta: { before: 1475, after: 1487 },
  myBoards: [
    { no: 1, state: 'done', contractLabel: '4♠ by S', scoreNS: 620, pct: 58 },
    { no: 2, state: 'done', contractLabel: '3NT+1 by N', scoreNS: 630, pct: 74 },
    { no: 3, state: 'done', contractLabel: '2♥-1 by S', scoreNS: -100, pct: 41 },
    { no: 4, state: 'done', contractLabel: '4♥ by W', scoreNS: -420, pct: 71 },
  ],
  standings: [
    { userId: 7, handle: 'Alice', kind: 'human', boardsDone: 4, totalPct: 71, complete: true, rank: 1 },
    { userId: 1, handle: 'Margaret', kind: 'human', boardsDone: 4, totalPct: 61, complete: true, rank: 2 },
    { userId: 8, handle: 'Bob', kind: 'human', boardsDone: 4, totalPct: 18, complete: true, rank: 3 },
  ],
};

/**
 * an ai_field tournament: same 3 humans as tournamentComplete plus a house
 * row — a full field member, so it interleaves pct-sorted and takes a real
 * rank (pushing Margaret and Bob down one place each)
 */
export const tournamentCompleteWithHouse: TournamentInfo = {
  ...tournamentComplete,
  standings: [
    { userId: 7, handle: 'Alice', kind: 'human', boardsDone: 4, totalPct: 71, complete: true, rank: 1 },
    { userId: 90, handle: 'The Shark', kind: 'ai', boardsDone: 4, totalPct: 66, complete: true, rank: 2 },
    { userId: 1, handle: 'Margaret', kind: 'human', boardsDone: 4, totalPct: 61, complete: true, rank: 3 },
    { userId: 8, handle: 'Bob', kind: 'human', boardsDone: 4, totalPct: 18, complete: true, rank: 4 },
  ],
};

// ---- player stats ----

const statPoint = (i: number) => ({
  tournamentId: i,
  tournamentName: `Tournament #${i}`,
  finishedAt: 1_780_000_000 + i * 86_400,
});

export const playerStatsFull: PlayerStats = {
  user: { id: 1, handle: 'Margaret', picture: null, elo: 1487, createdAt: 1_770_000_000, kind: 'human' },
  totals: {
    boardsCompleted: 214,
    tournamentsPlayed: 12,
    tournamentsCompleted: 11,
    ratedTournaments: 10,
    currentElo: 1487,
    peakElo: 1502,
    avgPct: 57,
    bestPct: { pct: 74, tournamentName: 'Tournament #9', tournamentId: 9 },
    worstPct: { pct: 31, tournamentName: 'Tournament #4', tournamentId: 4 },
    avgBidAccuracy: 78,
    gradeCounts: { excellent: 137, good: 58, fair: 15, poor: 4 },
    declarer: { boards: 88, made: 54 },
    defense: { boards: 126, beat: 66 },
    passedOut: 3,
    monthlyEloDelta: 34,
  },
  trickDelta: {
    boards: 88,
    avgDelta: 0.3,
    buckets: [
      { delta: -3, count: 5 },
      { delta: -2, count: 10 },
      { delta: -1, count: 19 },
      { delta: 0, count: 10 },
      { delta: 1, count: 16 },
      { delta: 2, count: 20 },
      { delta: 3, count: 8 },
    ],
  },
  percentiles: { elo: 72, avgPct: 64, bidAccuracy: 70, declaring: 58, ratedPlayers: 54, activePlayers: 60, declaringPlayers: 52 },
  eloSeries: Array.from({ length: 10 }, (_, i) => ({ ...statPoint(i + 2), elo: 1380 + i * 11 })),
  pctSeries: Array.from({ length: 10 }, (_, i) => ({ ...statPoint(i + 2), pct: 44 + ((i * 7) % 30), boards: 4, fieldSize: 8 })),
  accuracySeries: Array.from({ length: 10 }, (_, i) => ({ ...statPoint(i + 2), accuracy: 60 + i * 2, calls: 18 })),
  // server-ranked best to worst; totals sum to the 214 graded calls
  bidTypes: [
    { category: 'opening', total: 41, satisfactory: 40 },
    { category: 'pass', total: 62, satisfactory: 58 },
    { category: 'response', total: 56, satisfactory: 52 },
    { category: 'rebid', total: 25, satisfactory: 21 },
    { category: 'double', total: 6, satisfactory: 5 },
    { category: 'overcall', total: 24, satisfactory: 19 },
  ],
  // server-ranked best to worst; a subset of the graded calls above (natural bids never appear here)
  conventions: [
    { family: 'stayman', total: 9, satisfactory: 8 },
    { family: 'blackwood', total: 3, satisfactory: 3 },
    { family: 'jacobyTransfer', total: 5, satisfactory: 2 },
  ],
  // sums to declarer.boards: 88 (51+30+7 tiers, 21+45+22 strains)
  contractMix: {
    partscore: { boards: 51, made: 38 },
    game: { boards: 30, made: 14 },
    slam: { boards: 7, made: 2 },
    doubled: { boards: 9, made: 5 },
    strains: { notrump: 21, major: 45, minor: 22 },
  },
  // a handful of days across the fixture's history, including one multi-board day
  dailyBoards: [
    { date: '2026-05-14', count: 4 },
    { date: '2026-05-21', count: 2 },
    { date: '2026-06-02', count: 1 },
    { date: '2026-06-09', count: 1 },
  ],
  // ranked by shared count; covers all three rivalLine branches (ahead/tied/behind).
  // Deliberately NOT userId 90 / 'The Shark' — several other fixtures reuse
  // playerStatsFull with the profile subject itself set to that id/handle
  // (see App.test.tsx, stats.test.tsx's house-profile test), and a rival row
  // with the same handle would collide with the page's own name heading.
  rivals: [
    { userId: 92, handle: 'The Novice', kind: 'ai', shared: 6, record: { ahead: 4, behind: 2, tied: 0 } },
    { userId: 50, handle: 'Marge', kind: 'human', shared: 5, record: { ahead: 2, behind: 2, tied: 1 } },
    { userId: 51, handle: 'Dev', kind: 'human', shared: 4, record: { ahead: 1, behind: 3, tied: 0 } },
  ],
};

export const playerStatsEmpty: PlayerStats = {
  user: { id: 1, handle: 'Margaret', picture: null, elo: 1200, createdAt: 1_770_000_000, kind: 'human' },
  totals: {
    boardsCompleted: 0,
    tournamentsPlayed: 0,
    tournamentsCompleted: 0,
    ratedTournaments: 0,
    currentElo: 1200,
    peakElo: 1200,
    avgPct: null,
    bestPct: null,
    worstPct: null,
    avgBidAccuracy: null,
    gradeCounts: { excellent: 0, good: 0, fair: 0, poor: 0 },
    declarer: { boards: 0, made: 0 },
    defense: { boards: 0, beat: 0 },
    passedOut: 0,
    monthlyEloDelta: null,
  },
  trickDelta: {
    boards: 0,
    avgDelta: null,
    buckets: ([-3, -2, -1, 0, 1, 2, 3] as const).map((delta) => ({ delta, count: 0 })),
  },
  percentiles: {
    elo: null,
    avgPct: null,
    bidAccuracy: null,
    declaring: null,
    ratedPlayers: 0,
    activePlayers: 0,
    declaringPlayers: 0,
  },
  eloSeries: [],
  pctSeries: [],
  accuracySeries: [],
  bidTypes: [],
  conventions: [],
  contractMix: {
    partscore: { boards: 0, made: 0 },
    game: { boards: 0, made: 0 },
    slam: { boards: 0, made: 0 },
    doubled: { boards: 0, made: 0 },
    strains: { notrump: 0, major: 0, minor: 0 },
  },
  dailyBoards: [],
  rivals: [],
};

// ---- leaderboard ----

export const leaderboardRows = [
  { id: 7, handle: 'Alice', picture: null, elo: 1642, rated_tournaments: 9, played_tournaments: 11, movement: 2 },
  { id: 10, handle: 'Henry', picture: null, elo: 1601, rated_tournaments: 8, played_tournaments: 9, movement: -1 },
  { id: 1, handle: 'Margaret', picture: null, elo: 1487, rated_tournaments: 10, played_tournaments: 12, movement: 3 },
  { id: 8, handle: 'Bob', picture: null, elo: 1466, rated_tournaments: 5, played_tournaments: 7, movement: null },
];
