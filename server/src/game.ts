import {
  BidEvaluation,
  Bidder,
  DdSolve,
  MC_SAMPLES,
  PLAY_NOISE,
  bidDecisionSeed,
  chooseCard,
  chooseCardSampled,
  loadPolicyModel,
  mcDecisionSeed,
  pickFromSolve,
  solveFutureTricks,
} from '@bridge/ai';
import {
  BidMeaning,
  Call,
  Card,
  Contract,
  Deal,
  Seat,
  auctionState,
  boardScoreNS,
  callName,
  contractLabel,
  dealBoard,
  explainBid,
  finalContract,
  hcp,
  legalCalls,
  legalCards,
  matchpoints,
  partnerOf,
  PlayState,
  playState,
  scoreBreakdown,
} from '@bridge/core';
import { BOARDS_PER_TOURNAMENT, BoardRow, TournamentRow, db } from './db.js';
import { boardDifficulty, recomputeElo } from './tournaments.js';

const HUMAN_SEAT: Seat = 2; // South
export { BOARDS_PER_TOURNAMENT };

const bidder = new Bidder(loadPolicyModel((process.env.AI_MODEL as 'sl' | 'rl-fsp') ?? 'sl'));

const stmtBoard = db.prepare(`SELECT * FROM boards WHERE tournament_id = ? AND user_id = ? AND board_no = ?`);
const stmtCreateBoard = db.prepare(
  `INSERT INTO boards (tournament_id, user_id, board_no) VALUES (?, ?, ?) RETURNING *`,
);
// Scoped to full row identity, not bare id: SQLite reuses rowids after
// deletes, so a request that held a GameBoard across an await while demo
// mode's reset wiped and reseeded the database could otherwise UPDATE a
// recycled id belonging to a different user's board. With the full scope the
// stale write matches nothing and drops harmlessly.
const stmtSaveBoard = db.prepare(
  `UPDATE boards SET state = ?, calls = ?, plays = ?, bid_evals = ?, contract = ?, tricks_declarer = ?, score_ns = ?, updated_at = unixepoch()
   WHERE id = ? AND tournament_id = ? AND user_id = ?`,
);
const stmtBoardResults = db.prepare(
  `SELECT b.*, u.handle AS user_handle FROM boards b JOIN users u ON u.id = b.user_id
   WHERE b.tournament_id = ? AND b.board_no = ? AND b.state = 'done' ORDER BY b.updated_at`,
);

interface GameBoard {
  row: BoardRow;
  /** the owning tournament — carries the seed and robot difficulty for this board */
  tournament: TournamentRow;
  deal: Deal;
  calls: Call[];
  plays: Card[];
  bidEvals: (BidEvaluation & { call: Call; bestMeaning?: BidMeaning | null })[];
  contract: Contract | null;
  /**
   * Set by advanceRobots when this request resolved a laydown claim.
   * Transient — never persisted (loadBoard builds a fresh GameBoard per
   * request, so it always starts unset) and never added to the boards table.
   */
  claimed?: boolean;
}

export function loadBoard(t: TournamentRow, userId: number, boardNo: number, createIfMissing: boolean): GameBoard | null {
  let row = stmtBoard.get(t.id, userId, boardNo) as BoardRow | undefined;
  if (!row) {
    if (!createIfMissing) return null;
    row = stmtCreateBoard.get(t.id, userId, boardNo) as BoardRow;
  }
  return {
    row,
    tournament: t,
    deal: dealBoard(t.seed, boardNo),
    calls: JSON.parse(row.calls),
    plays: JSON.parse(row.plays),
    bidEvals: JSON.parse(row.bid_evals),
    contract: row.contract ? JSON.parse(row.contract) : null,
  };
}

function save(b: GameBoard): void {
  stmtSaveBoard.run(
    b.row.state,
    JSON.stringify(b.calls),
    JSON.stringify(b.plays),
    JSON.stringify(b.bidEvals),
    b.contract ? JSON.stringify(b.contract) : null,
    b.row.tricks_declarer,
    b.row.score_ns,
    b.row.id,
    b.row.tournament_id,
    b.row.user_id,
  );
}

/** function boundary defeats TS narrowing: advanceRobots mutates row.state */
function boardDone(row: BoardRow): boolean {
  return row.state === 'done';
}

/**
 * Does the human play this hand? The human plays their whole side: South
 * always, and North whenever N-S is the declaring side (South declaring →
 * South + dummy North; North declaring → the board flips and the human runs
 * partner's hand). Defending, the human plays only South.
 */
function humanControls(hand: Seat, contract: Contract): boolean {
  if (hand === HUMAN_SEAT) return true;
  return hand === partnerOf(HUMAN_SEAT) && contract.declarer % 2 === HUMAN_SEAT % 2;
}

function finishBoard(b: GameBoard): void {
  if (b.contract) {
    const ps = playState(b.deal, b.contract, b.plays);
    b.row.tricks_declarer = ps.declarerTricks;
    b.row.score_ns = boardScoreNS(b.contract, b.deal.vul, ps.declarerTricks);
  } else {
    b.row.tricks_declarer = null;
    b.row.score_ns = 0; // passed out
  }
  b.row.state = 'done';
}

/**
 * Advance all robot actions until it's the human's turn or the board is over.
 * Deterministic: model argmax bidding, double-dummy-optimal card play.
 */
export async function advanceRobots(b: GameBoard): Promise<void> {
  for (;;) {
    if (b.row.state === 'bidding') {
      const auction = auctionState(b.deal.dealer, b.calls);
      if (auction.isOver) {
        b.contract = finalContract(b.deal.dealer, b.calls);
        if (!b.contract) {
          finishBoard(b);
          return;
        }
        b.row.state = 'playing';
        continue;
      }
      if (auction.turn === HUMAN_SEAT) return;
      b.calls.push(
        bidder.chooseCall(b.deal, b.calls, {
          difficulty: boardDifficulty(b.tournament, b.row.board_no),
          seed: bidDecisionSeed(b.tournament.seed, b.row.board_no, b.calls.length),
        }),
      );
      continue;
    }
    if (b.row.state === 'playing') {
      const ps = playState(b.deal, b.contract!, b.plays);
      if (ps.isOver) {
        finishBoard(b);
        return;
      }
      const legal = legalCards(b.deal, ps);
      if (legal.length > 1) {
        // A forced (single-legal-card) node carries no new branching
        // information for a claim, so we skip the solve there — the next
        // real decision point is checked the following iteration regardless.
        const solve = await solveFutureTricks(b.deal, b.contract!, b.plays);
        const remainingTricks = 13 - ps.completedTricks.length;
        if (solve.bestScore === remainingTricks || solve.bestScore === 0) {
          // Either the side to move (bestScore === remaining) or the
          // defense (bestScore === 0) is a 100% laydown from here. Play out
          // the whole rest of the hand DD-optimally for both sides — this is
          // the only way the claim's outcome is guaranteed identical to what
          // continued play would have produced.
          b.claimed = true;
          b.plays.push(pickFromSolve(legal, solve));
          await resolveClaim(b);
          continue;
        }
        if (!humanControls(ps.handToPlay, b.contract!)) {
          b.plays.push(await robotCard(b, ps, legal, solve));
          continue;
        }
        return;
      }
      // Forced node: chooseCard returns the single legal card without a
      // solve — identical at every difficulty.
      if (humanControls(ps.handToPlay, b.contract!)) return;
      b.plays.push(await chooseCard(b.deal, b.contract!, b.plays));
      continue;
    }
    return; // done
  }
}

/**
 * The robot's card at a non-forced, non-claim node. Difficulty is resolved
 * PER BOARD (boardDifficulty): 'perfect' — the legacy value every
 * pre-difficulty tournament resolves to — is byte-for-byte the historical
 * path, pickFromSolve on the true-deal solve advanceRobots already ran for
 * the claim gate. The player-facing tiers use sampled double-dummy play
 * (packages/ai/play-mc.ts) — a pure function of public state + tournament
 * seed, so every player on this board still faces the identical robot
 * (invariant 1); the tier sets K, whether OPPONENTS may infer from the
 * auction (beginner is auction-blind), and — PLAY_NOISE, layered on top of
 * K, orthogonal to belief formation — how often opponents settle for a
 * near-best card instead of the single best one. Robot North exists only as
 * the human's defensive partner (humanControls gives the human every N-S
 * hand when N-S declares), so actor seat 0 gets kPartner, is always
 * auction-aware, and is never subject to PLAY_NOISE (playTopN stays 1);
 * robot E-W — declaring, controlling their dummy, or defending — get the
 * tier's kOpp/auctionAware/playTopN.
 */
async function robotCard(b: GameBoard, ps: PlayState, legal: Card[], solve: DdSolve): Promise<Card> {
  const difficulty = boardDifficulty(b.tournament, b.row.board_no);
  if (difficulty === 'perfect') return pickFromSolve(legal, solve);
  const dummy = partnerOf(b.contract!.declarer);
  const actor = ps.handToPlay === dummy ? b.contract!.declarer : ps.handToPlay;
  const isPartner = actor === 0;
  const tier = MC_SAMPLES[difficulty];
  return chooseCardSampled(b.deal, b.contract!, b.plays, {
    k: isPartner ? tier.kPartner : tier.kOpp,
    useAuction: isPartner ? true : tier.auctionAware,
    playTopN: isPartner ? 1 : PLAY_NOISE[difficulty].topN,
    seed: mcDecisionSeed(b.tournament.seed, b.row.board_no, b.plays.length),
    dealer: b.deal.dealer,
    calls: b.calls,
  });
}

/**
 * Play out every remaining card DD-optimally for both sides once a claim
 * fires. Deliberately true-DD at every difficulty: a claim only fires on a
 * position whose outcome is 100% determined double-dummy, and resolving it
 * with perfect play is what keeps the fast-forwarded score identical to what
 * continued play would have produced.
 */
async function resolveClaim(b: GameBoard): Promise<void> {
  while (!playState(b.deal, b.contract!, b.plays).isOver) {
    b.plays.push(await chooseCard(b.deal, b.contract!, b.plays));
  }
}

export async function submitCall(
  b: GameBoard,
  call: Call,
): Promise<BidEvaluation & { call: Call; bestMeaning: BidMeaning | null }> {
  if (b.row.state !== 'bidding') throw httpError(409, 'not in bidding phase');
  const auction = auctionState(b.deal.dealer, b.calls);
  if (auction.isOver || auction.turn !== HUMAN_SEAT) throw httpError(409, 'not your turn');
  if (!legalCalls(auction)[call]) throw httpError(400, 'illegal call');
  const bare = bidder.evaluate(b.deal, b.calls, call);
  // Name the robot's preferred call so the UI can teach, not just score.
  const evaluation = { ...bare, call, bestMeaning: meaningFor(b.deal.dealer, b.calls, bare.bestCall) };
  b.calls.push(call);
  b.bidEvals.push(evaluation);
  await advanceRobots(b);
  save(b);
  if (boardDone(b.row)) recomputeElo();
  return evaluation;
}

export async function submitPlay(b: GameBoard, card: Card): Promise<void> {
  if (b.row.state !== 'playing') throw httpError(409, 'not in play phase');
  const ps = playState(b.deal, b.contract!, b.plays);
  if (ps.isOver || !humanControls(ps.handToPlay, b.contract!)) throw httpError(409, 'not your turn');
  if (!legalCards(b.deal, ps).includes(card)) throw httpError(400, 'illegal card');
  b.plays.push(card);
  await advanceRobots(b);
  save(b);
  if (boardDone(b.row)) recomputeElo();
}

/** Ensure a fresh board has robots advanced up to the human (dealer may be W/N/E). */
export async function ensureAdvanced(b: GameBoard): Promise<void> {
  const before = JSON.stringify([b.calls, b.plays, b.row.state]);
  await advanceRobots(b);
  if (JSON.stringify([b.calls, b.plays, b.row.state]) !== before) {
    save(b);
    if (boardDone(b.row)) recomputeElo();
  }
}

function meaningFor(dealer: Seat, callsBefore: Call[], call: Call): BidMeaning | null {
  try {
    return explainBid(dealer, callsBefore, call);
  } catch {
    return null;
  }
}

/** The client-facing view of a board, redacted for the acting user. */
export function boardView(t: TournamentRow, b: GameBoard, viewerElo: number): Record<string, unknown> {
  const deal = b.deal;
  const auction = auctionState(deal.dealer, b.calls);
  const seatNames = ['North', 'East', 'South (you)', 'West'];

  const auctionView = b.calls.map((call, i) => {
    const seat = ((deal.dealer + i) % 4) as Seat;
    return {
      seat,
      call,
      name: callName(call),
      isHuman: seat === HUMAN_SEAT,
      meaning: meaningFor(deal.dealer, b.calls.slice(0, i), call),
    };
  });

  const view: Record<string, unknown> = {
    tournamentId: t.id,
    tournamentName: t.name,
    difficulty: boardDifficulty(t, b.row.board_no),
    boardNo: b.row.board_no,
    totalBoards: BOARDS_PER_TOURNAMENT,
    state: b.row.state,
    dealer: deal.dealer,
    vul: deal.vul,
    seatNames,
    hand: remaining(deal, b.plays, HUMAN_SEAT),
    fullHand: deal.hands[HUMAN_SEAT],
    hcp: hcp(deal.hands[HUMAN_SEAT]),
    auction: auctionView,
    bidEvals: b.bidEvals,
  };

  if (b.row.state === 'bidding') {
    if (!auction.isOver && auction.turn === HUMAN_SEAT) {
      const mask = legalCalls(auction);
      const legal = mask.map((ok, a) => (ok ? a : -1)).filter((a) => a >= 0);
      view.legalCalls = legal;
      // meanings shown to the user BEFORE they commit a bid
      view.legalCallMeanings = Object.fromEntries(legal.map((a) => [a, meaningFor(deal.dealer, b.calls, a)]));
      view.myTurn = true;
    }
  }

  if (b.row.state !== 'bidding' && b.contract) {
    const ps = playState(deal, b.contract, b.plays);
    const dummy = partnerOf(b.contract.declarer);
    // When partner (North) declares, the human takes over the declarer hand
    // and the board flips: North's cards at the bottom, South face up as dummy.
    const flipped = b.contract.declarer === partnerOf(HUMAN_SEAT);
    const playingSeat = flipped ? b.contract.declarer : HUMAN_SEAT;
    view.contract = b.contract;
    view.contractLabel = contractLabel(b.contract);
    view.declarer = b.contract.declarer;
    view.dummy = dummy;
    view.flipped = flipped;
    view.playingSeat = playingSeat;
    view.hand = remaining(deal, b.plays, playingSeat);
    view.hcp = hcp(deal.hands[playingSeat]);
    view.currentTrick = ps.currentTrick;
    view.completedTricks = ps.completedTricks.length;
    view.declarerTricks = ps.declarerTricks;
    view.defenderTricks = ps.defenderTricks;
    view.lastTrick = ps.completedTricks.length ? ps.completedTricks[ps.completedTricks.length - 1] : null;
    // The human always sees their own (South) cards; dummy is public after the
    // opening lead. Both conditions hold for every hand we ever send here.
    // Sent for 'done' too (not just 'playing'): a laydown claim can resolve
    // many tricks in one response, and the client's claim fast-forward
    // (stageClaimSteps) reconstructs dummy's hand shrinking trick-by-trick
    // from this same field — if it were omitted once the board flips to
    // 'done', dummy's whole fan would vanish instantly instead of animating.
    if ((b.row.state === 'playing' || b.row.state === 'done') && (ps.dummyVisible || dummy === HUMAN_SEAT)) {
      view.dummyHand = remaining(deal, b.plays, dummy);
      view.dummyHcp = hcp(deal.hands[dummy]);
    }
    if (b.row.state === 'playing' && !ps.isOver && humanControls(ps.handToPlay, b.contract)) {
      view.myTurn = true;
      view.handToPlay = ps.handToPlay;
      view.legalCards = legalCards(deal, ps);
    }
  }

  if (b.row.state === 'done') {
    view.result = boardResult(t, b, viewerElo);
    view.allHands = deal.hands;
    view.playHistory = b.contract ? playState(deal, b.contract, b.plays).completedTricks : [];
    if (b.claimed) view.claimed = true;
  }
  return view;
}

function remaining(deal: Deal, plays: Card[], seat: Seat): Card[] {
  const played = new Set(plays);
  return deal.hands[seat].filter((c) => !played.has(c));
}

/** Result + field comparison for a completed board. */
function boardResult(t: TournamentRow, b: GameBoard, _viewerElo: number): Record<string, unknown> {
  const rows = stmtBoardResults.all(t.id, b.row.board_no) as (BoardRow & { user_handle: string })[];
  const scores = rows.map((r) => r.score_ns ?? 0);
  const mps = matchpoints(scores);
  const field = rows.map((r, i) => ({
    userId: r.user_id,
    handle: r.user_handle,
    contract: r.contract ? contractLabel(JSON.parse(r.contract), tricksOf(r)) : 'Passed out',
    scoreNS: r.score_ns ?? 0,
    pct: Math.round(mps[i].pct * 10) / 10,
    isMe: r.user_id === b.row.user_id,
  }));
  const mine = field.find((f) => f.isMe);
  return {
    contractLabel: b.contract ? contractLabel(b.contract, b.row.tricks_declarer ?? undefined) : 'Passed out',
    tricksDeclarer: b.row.tricks_declarer,
    scoreNS: b.row.score_ns,
    pct: mine?.pct ?? 50,
    field: field.sort((a, b2) => b2.scoreNS - a.scoreNS),
    bidAccuracy: bidAccuracy(b.bidEvals),
    // itemized duplicate scoring for the toll-receipt screen; null on a pass-out
    breakdown:
      b.contract && b.row.tricks_declarer != null
        ? scoreBreakdown(b.contract, b.deal.vul, b.row.tricks_declarer)
        : null,
  };
}

function tricksOf(r: BoardRow): number | undefined {
  return r.tricks_declarer ?? undefined;
}

function bidAccuracy(evals: { score: number }[]): number | null {
  if (!evals.length) return null;
  return Math.round((evals.reduce((s, e) => s + e.score, 0) / evals.length) * 100);
}

export function httpError(status: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}
