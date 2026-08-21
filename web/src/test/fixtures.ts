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
  CompareMeasure,
  CompareView,
  Me,
  PlayerStats,
  TournamentInfo,
  TrickCard,
} from '../api';
import { cardSuit, makeBid } from '../api';
import { trickWinner } from '../components/game/playAnim';

// ---- users ----

export const meFixture: Me = {
  // onboardedAt set: the established player — App gates a null stamp into the
  // first-crossing tour (see meFreshCrosser).
  user: {
    id: 1,
    handle: 'Margaret',
    picture: null,
    elo: 1487,
    onboardedAt: 1700000000,
    ladderListed: true,
    autoClaim: true,
    bidFeedback: true,
    betaFeatures: true,
    doubleTapBid: false,
    trickClearMode: 'auto',
    trumpPlacement: 'suit',
    foilTrumps: false,
    // Comfortably past COMPARE_MIN_BOARDS, so this established player is
    // offered Compare; meFreshCrosser below is the other side of that gate.
    boards: 112,
    // Club earned; 12 tournaments (48 boards) toward diamond's 100-board
    // target = 48%, measured from zero per packages/core/src/medals.ts —
    // crossing the club threshold didn't reset this back to 0%.
    medals: { earned: ['c'], target: 'd', pct: 48, tournamentsRemaining: 13 },
  },
  devAuth: true,
  googleAuth: true,
};

export const meNoHandle: Me = { ...meFixture, user: { ...meFixture.user!, handle: null } };
export const meLoggedOut: Me = { user: null, devAuth: true, googleAuth: true };
/** Handle chosen, tour not yet taken — App shows the first crossing. */
// A brand-new account: no tour stamp, and no record either, so Compare's entry
// points stay hidden for them.
export const meFreshCrosser: Me = {
  ...meFixture,
  user: {
    ...meFixture.user!,
    onboardedAt: null,
    boards: 0,
    medals: { earned: [], target: 'c', pct: 0, tournamentsRemaining: 4 },
  },
};

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

/**
 * A board exactly as a fresh GET hands it over: West dealt, so the robots'
 * three opening calls are already on the tray and the human has not called at
 * all. stageOpeningBids's case, and boardBidding can't stand in for it —
 * South has bid there, which is precisely what makes a board a return visit
 * rather than a first arrival.
 */
export const boardBiddingOpening: BoardView = {
  ...base,
  state: 'bidding',
  myTurn: true,
  dealer: 3,
  auction: [entry(3, 0, 'Pass'), entry(0, bid1H, '1♥', meaning1H), entry(1, 0, 'Pass')],
  legalCalls,
  legalCallMeanings: {},
};

/**
 * The human's 2♥ plus the robots' three replies — a real bidding burst, i.e.
 * an auction that GROWS. boardBiddingRobots can't stand in for it: its
 * auction is a truncated slice, shorter than boardBidding's, which predates
 * staged bidding and would leave stageBidSteps with nothing to reveal.
 */
export const boardBiddingBurst: BoardView = {
  ...base,
  state: 'bidding',
  myTurn: true,
  auction: [
    ...biddingAuction, // 6 entries, South to call
    entry(2, bid2H, '2♥', meaning2H), // the human's call
    entry(3, makeBid(2, 3), '2♠'), // W
    entry(0, 0, 'Pass'), // N
    entry(1, 0, 'Pass'), // E — back to South
  ],
  legalCalls,
  legalCallMeanings: {},
};

/**
 * The auction ENDING, on 2♥ by South — the one transition the trump Draw
 * plays on (see trumpDraw.ts). An extension of boardBidding's auction, so
 * stageBidSteps reveals the closing calls and then hands off into play with
 * West's opening lead already made and dummy tabled.
 *
 * Hearts on purpose: South holds five of them behind three spades, so the
 * re-sort genuinely moves cards. A spade contract would be the no-op case,
 * which is worth a test of its own but cannot stand in for this one.
 */
export const boardAuctionEndsHearts: BoardView = {
  ...base,
  state: 'playing',
  myTurn: true,
  auction: [
    ...biddingAuction, // 6 entries, South to call
    entry(2, bid2H, '2♥', meaning2H), // the human's call
    entry(3, 0, 'Pass'), // W
    entry(0, 0, 'Pass'), // N
    entry(1, 0, 'Pass'), // E — three passes end it
  ],
  contractLabel: '2♥ by S',
  contract: { level: 2, strain: 2, declarer: 2, doubled: false, redoubled: false },
  declarer: 2,
  dummy: 0,
  currentTrick: [{ seat: 3, card: card(D, 'K') }],
  completedTricks: 0,
  declarerTricks: 0,
  defenderTricks: 0,
  lastTrick: null,
  dummyHand: northHand,
  dummyHcp: 13,
  handToPlay: 0, // South declares, so the human plays dummy's card first
  legalCards: [card(D, 'A'), card(D, 'Q'), card(D, '7'), card(D, '4')],
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

/** A "Play From Here" rehearsal, mid-play — everything about the live
 *  PlayPhase screen is identical to boardPlaying; only board.rehearsal is
 *  new, which BoardHead reads to relabel the header and swap in END.
 *  originBoardNo matches board.boardNo (2, from `base`) — a rehearsal's own
 *  board_no is always copied verbatim from the board it branched from. */
export const boardPlayingRehearsal: BoardView = {
  ...boardPlaying,
  rehearsal: { originTournamentId: 20, originBoardNo: 2, branchPly: 24 },
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

/** A finished "Play From Here" rehearsal — an overtrick better than the real
 *  table (boardDone's own +620), so it exercises both the itemized THIS LINE
 *  receipt and the positive delta framing in the VS YOUR REAL TABLE panel. */
export const boardDoneRehearsal: BoardView = {
  ...boardDone,
  rehearsal: { originTournamentId: 20, originBoardNo: 2, branchPly: 24 },
  result: {
    ...boardDone.result!,
    contractLabel: '4♠+1 by S',
    tricksDeclarer: 11,
    scoreNS: 650,
    breakdown: {
      lines: [
        { kind: 'odd-tricks', label: 'Odd tricks', detail: '4 × 30', amount: 120 },
        { kind: 'game-bonus', label: 'Game bonus', detail: 'vulnerable', amount: 500 },
        { kind: 'overtricks', label: 'Overtricks', detail: '1 × 30', amount: 30 },
      ],
      vulnerable: true,
      total: 650,
    },
  },
  originResult: {
    contractLabel: '4♠ by S',
    tricksDeclarer: 10,
    scoreNS: 620,
    pct: 58,
    bidAccuracy: 89,
    breakdown: boardDone.result!.breakdown,
    field: boardDone.result!.field,
  },
  lineMatchpoints: 70,
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
    { userId: 7, handle: 'Alice', kind: 'human', boardsDone: 4, totalPct: 71, complete: true, rank: 1, eloDelta: 14 },
    // the house never rates, so its swing is null however well it played
    { userId: 90, handle: 'The Shark', kind: 'ai', boardsDone: 4, totalPct: 66, complete: true, rank: 2, eloDelta: null },
    { userId: 1, handle: 'Margaret', kind: 'human', boardsDone: 4, totalPct: 61, complete: true, rank: 3, eloDelta: 2 },
    { userId: 8, handle: 'Bob', kind: 'human', boardsDone: 4, totalPct: 18, complete: true, rank: 4, eloDelta: -16 },
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
    earnedMedals: ['c'],
    streakDays: 5,
    currentElo: 1487,
    peakElo: 1502,
    avgPct: 57,
    bestPct: { pct: 74, tournamentName: 'Tournament #9', tournamentId: 9 },
    // 31 of 214 boards -> "1 in 7 boards"
    tops: { count: 31, latest: { tournamentId: 12, boardNo: 3 } },
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
    // `boards` decides whether the row offers a COMPARE link: the first two
    // clear COMPARE_MIN_BOARDS, the third deliberately does not.
    { userId: 92, handle: 'The Novice', kind: 'ai', shared: 6, record: { ahead: 4, behind: 2, tied: 0 }, boards: 220 },
    { userId: 50, handle: 'Marge', kind: 'human', shared: 5, record: { ahead: 2, behind: 2, tied: 1 }, boards: 48 },
    { userId: 51, handle: 'Dev', kind: 'human', shared: 4, record: { ahead: 1, behind: 3, tied: 0 }, boards: 7 },
  ],
};

export const playerStatsEmpty: PlayerStats = {
  user: { id: 1, handle: 'Margaret', picture: null, elo: 1200, createdAt: 1_770_000_000, kind: 'human' },
  totals: {
    boardsCompleted: 0,
    tournamentsPlayed: 0,
    tournamentsCompleted: 0,
    earnedMedals: [],
    streakDays: 0,
    currentElo: 1200,
    peakElo: 1200,
    avgPct: null,
    bestPct: null,
    tops: { count: 0, latest: null },
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

// The two windows deliberately disagree per row: 7 DAYS is the default reading
// and 1 DAY is the quieter one, so a fixture where they matched would let the
// switch appear to work while reading the same field twice.
export const leaderboardRows = [
  { id: 7, handle: 'Alice', picture: null, elo: 1642, rated_tournaments: 9, played_tournaments: 11, movement1d: 1, movement7d: 2 },
  { id: 10, handle: 'Henry', picture: null, elo: 1601, rated_tournaments: 8, played_tournaments: 9, movement1d: 0, movement7d: -1 },
  { id: 1, handle: 'Margaret', picture: null, elo: 1487, rated_tournaments: 10, played_tournaments: 12, movement1d: -1, movement7d: 3 },
  // on the ladder for less than a week: a real 1-day reading, no 7-day position
  { id: 8, handle: 'Bob', picture: null, elo: 1466, rated_tournaments: 5, played_tournaments: 7, movement1d: 2, movement7d: null },
];

// meFixture (id 1, Margaret) already has 10 rated tournaments — past the
// provisional quota, so the "you'll join the field" note stays hidden by default.
export const houseRows = [
  { id: 901, handle: 'The Novice', picture: null },
  { id: 902, handle: 'The Regular', picture: null },
  { id: 903, handle: 'The Shark', picture: null },
];

export const leaderboardResponse = {
  leaderboard: leaderboardRows,
  house: houseRows,
  provisionalMin: 4,
  yourRatedTournaments: 10 as number | null,
};

// ---- activity feed ----

/**
 * Every timestamp below is anchored in LOCAL time on purpose.
 *
 * The feed groups by the viewer's calendar day and by timeGreeting()'s hour
 * cutoffs, so a fixture built from a UTC instant would land in a different day
 * or block depending on where the suite runs. Building them with the local
 * Date constructor makes "Jul 23, 9:41 PM, evening" true in every timezone,
 * and ACTIVITY_NOW below is the matching local "now" tests should pass in.
 */
const at = (day: number, hour: number, minute: number) => Math.floor(new Date(2026, 6, day, hour, minute).getTime() / 1000);

/** Thu Jul 23 2026, 10:20 PM local — after every event in activityResponse. */
export const ACTIVITY_NOW = new Date(2026, 6, 23, 22, 20);

export const activityResponse = {
  since: at(15, 0, 0),
  players: {
    '1': { handle: 'Margaret', picture: null },
    '7': { handle: 'Alice', picture: null },
    '8': { handle: 'Bob', picture: null },
  },
  events: [
    // Alice: an evening run of 8 boards across two crossings, one of which rated.
    ...[at(23, 19, 5), at(23, 19, 20), at(23, 19, 40), at(23, 20, 5)].map((t) => ({
      kind: 'board' as const,
      userId: 7,
      at: t,
    })),
    ...[at(23, 20, 30), at(23, 20, 50), at(23, 21, 20), at(23, 21, 41)].map((t) => ({
      kind: 'board' as const,
      userId: 7,
      at: t,
    })),
    {
      kind: 'crossing' as const,
      userId: 7,
      at: at(23, 20, 5),
      tournamentId: 40,
      tournamentName: 'Tournament #40',
      pct: 55.5,
      rank: 3,
      of: 5,
      eloDelta: null, // nobody else finished it — unrated, and must not print as 0
    },
    {
      kind: 'crossing' as const,
      userId: 7,
      at: at(23, 21, 41),
      tournamentId: 41,
      tournamentName: 'Tournament #41',
      pct: 62,
      rank: 2,
      of: 5,
      eloDelta: 26,
    },
    // Bob joined this evening and hasn't played a board.
    { kind: 'joined' as const, userId: 8, at: at(23, 19, 15) },
    // Margaret (meFixture, "you"): an afternoon run that lost rating.
    ...[at(23, 16, 10), at(23, 16, 20), at(23, 16, 30), at(23, 16, 38)].map((t) => ({
      kind: 'board' as const,
      userId: 1,
      at: t,
    })),
    {
      kind: 'crossing' as const,
      userId: 1,
      at: at(23, 16, 38),
      tournamentId: 39,
      tournamentName: 'Tournament #39',
      pct: 47,
      rank: 4,
      of: 5,
      eloDelta: -11,
    },
    // Yesterday morning: Alice's very first crossing, carrying a milestone.
    ...[at(22, 7, 30), at(22, 7, 40), at(22, 7, 50), at(22, 7, 58)].map((t) => ({
      kind: 'board' as const,
      userId: 7,
      at: t,
    })),
    {
      kind: 'crossing' as const,
      userId: 7,
      at: at(22, 7, 58),
      tournamentId: 38,
      tournamentName: 'Tournament #38',
      pct: 68,
      rank: 1,
      of: 4,
      eloDelta: 19,
    },
    { kind: 'milestone' as const, userId: 7, at: at(22, 7, 58), milestone: 'first-crossing' as const },
  ],
};

/** The cold start: a signed-in player looking at a week nobody crossed. */
export const activityEmpty = { since: at(15, 0, 0), players: {}, events: [] };

// ---- compare ----
//
// The server decides every verdict (server/src/compare.ts), so these fixtures
// carry gate/fullTilt/verdict as they arrive over the wire — the page never
// recomputes them. The four measures below deliberately cover all four states:
// called-for-you, called-for-them, level, and set aside.

const measure = (over: Partial<CompareMeasure> & Pick<CompareMeasure, 'key' | 'label'>): CompareMeasure => ({
  panel: 'headline',
  a: 0,
  b: 0,
  unit: 'pct',
  margin: 0,
  gate: 5,
  fullTilt: 20,
  verdict: 'level',
  samples: [40, 40],
  ...over,
});

const COMPARE_MEASURES: CompareMeasure[] = [
  // provisional: neither side is rated enough for a rating verdict
  measure({ key: 'elo', label: 'NICKEL RATING', a: 1284, b: 1341, unit: 'elo', margin: -57,
    gate: 35, fullTilt: 140, verdict: 'aside', reason: 'provisional', samples: [2, 3] }),
  measure({ key: 'bidAccuracy', label: 'BID ACCURACY', a: 71, b: 66, margin: 5,
    gate: 3.4, fullTilt: 7, verdict: 'you', samples: [412, 531] }),
  measure({ key: 'declaring', label: 'DECLARING', a: 63, b: 71, margin: -8,
    gate: 12.3, fullTilt: 14, verdict: 'level', samples: [58, 74] }),
  measure({ key: 'defending', label: 'DEFENDING', a: 41, b: 38, margin: 3,
    gate: 14.3, fullTilt: 10, verdict: 'aside', reason: 'thin', samples: [47, 62] }),
  measure({ key: 'bidType:overcall', label: 'OVERCALLS', panel: 'bidType', a: 51, b: 70,
    margin: -19, gate: 9.8, fullTilt: 20, verdict: 'them', samples: [42, 58] }),
  measure({ key: 'contract:slam', label: 'SLAM', panel: 'contract', a: 75, b: 60, margin: 15,
    gate: 46.2, fullTilt: 20, verdict: 'aside', reason: 'thin', samples: [4, 5] }),
];

const compareSides = {
  you: { id: 1, handle: 'Margaret', picture: null, kind: 'human' as const, boards: 112 },
  them: { id: 50, handle: 'Marge', picture: null, kind: 'human' as const, boards: 143 },
};

/** Two players who have met six times — the head-to-head slip is the hero. */
export const compareMet: CompareView = {
  ...compareSides,
  eligible: true,
  minBoards: 16,
  headToHead: { shared: 6, ahead: 2, behind: 3, tied: 1, sequence: ['you', 'them', 'them', 'you', 'level', 'them'] },
  commonGround: null,
  measures: COMPARE_MEASURES,
  context: [
    { key: 'bestPct', label: 'BEST CROSSING', a: 78.5, b: 72, unit: 'pct1' },
    { key: 'boards', label: 'BOARDS PLAYED', a: 112, b: 143, unit: 'count' },
  ],
  tally: { you: 1, them: 1, level: 1, aside: 3 },
};

/** Never crossed: the common-ground panel stands in for head-to-head. */
export const compareUnmet: CompareView = {
  ...compareMet,
  them: { id: 60, handle: 'Vance', picture: null, kind: 'human', boards: 61 },
  headToHead: null,
  commonGround: [
    { userId: 90, handle: 'The Novice', you: { shared: 26, ahead: 19, behind: 7, tied: 0, sequence: [] },
      them: { shared: 14, ahead: 9, behind: 5, tied: 0, sequence: [] } },
    { userId: 91, handle: 'The Shark', you: { shared: 26, ahead: 8, behind: 18, tied: 0, sequence: [] },
      them: { shared: 14, ahead: 6, behind: 8, tied: 0, sequence: [] } },
  ],
};

/** Under the floor on the other side — the "not enough boards yet" state. */
export const compareThin: CompareView = {
  you: compareSides.you,
  them: { id: 70, handle: 'Newcomer', picture: null, kind: 'human', boards: 4 },
  eligible: false,
  minBoards: 16,
  headToHead: null,
  commonGround: null,
  measures: [],
  context: [],
  tally: { you: 0, them: 0, level: 0, aside: 0 },
};


// ---- a fully played-out done board, for the Analyze/replay tests ----

/** simple legal play-out: follow suit when possible, else the first card */
export function genPlayHistory(hands: number[][], declarer: number, strain: number): TrickCard[][] {
  const remaining = hands.map((h) => [...h]);
  let leader = (declarer + 1) % 4;
  const tricks: TrickCard[][] = [];
  for (let t = 0; t < 13; t++) {
    const trick: TrickCard[] = [];
    for (let i = 0; i < 4; i++) {
      const seat = (leader + i) % 4;
      const hand = remaining[seat];
      const led = trick.length ? cardSuit(trick[0].card) : null;
      let idx = led !== null ? hand.findIndex((c) => cardSuit(c) === led) : 0;
      if (idx < 0) idx = 0;
      trick.push({ seat, card: hand.splice(idx, 1)[0] });
    }
    tricks.push(trick);
    leader = trickWinner(trick, strain);
  }
  return tricks;
}

/** boardDone with a consistent 13-trick playHistory (4♠ by South over allHands) */
export const donePlayed: BoardView = {
  ...boardDone,
  contract: { level: 4, strain: 3, declarer: 2, doubled: false, redoubled: false },
  playingSeat: 2,
  flipped: false,
  playHistory: genPlayHistory(allHands, 2, 3),
};
