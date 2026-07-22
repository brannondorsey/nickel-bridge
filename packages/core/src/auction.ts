import {
  BID_OFFSET,
  Call,
  Contract,
  DOUBLE,
  Deal,
  PASS,
  REDOUBLE,
  Seat,
  Strain,
  bidLevel,
  bidStrain,
  isBid,
  nextSeat,
  sameSide,
} from './types.js';

/**
 * Pure auction state derived from (dealer, calls). Mirrors the rules of the
 * pgx bridge_bidding environment (which itself follows the laws of bridge):
 *  - Pass always legal.
 *  - A bid must be higher than the last bid.
 *  - X legal when the last bid was made by an opponent and is undoubled.
 *  - XX legal when the last bid was doubled by an opponent of the bidding side.
 *  - Auction ends after 4 opening passes (passed out) or 3 passes following a call.
 */
export interface AuctionState {
  calls: Call[];
  /** seat to act (meaningless if over) */
  turn: Seat;
  isOver: boolean;
  passedOut: boolean;
  lastBid: Call | null;
  lastBidder: Seat | null;
  doubled: boolean;
  redoubled: boolean;
}

export function auctionState(dealer: Seat, calls: Call[]): AuctionState {
  let lastBid: Call | null = null;
  let lastBidder: Seat | null = null;
  let doubled = false;
  let redoubled = false;
  let passRun = 0;

  calls.forEach((call, i) => {
    const seat = ((dealer + i) % 4) as Seat;
    if (call === PASS) {
      passRun++;
    } else if (call === DOUBLE) {
      doubled = true;
      passRun = 0;
    } else if (call === REDOUBLE) {
      redoubled = true;
      passRun = 0;
    } else {
      lastBid = call;
      lastBidder = seat;
      doubled = false;
      redoubled = false;
      passRun = 0;
    }
  });

  const passedOut = lastBid === null && passRun >= 4;
  const isOver = passedOut || (lastBid !== null && passRun >= 3);
  return {
    calls,
    turn: ((dealer + calls.length) % 4) as Seat,
    isOver,
    passedOut,
    lastBid,
    lastBidder,
    doubled,
    redoubled,
  };
}

/** Boolean mask over the 38 actions for the seat currently to act. */
export function legalCalls(state: AuctionState): boolean[] {
  const mask = new Array<boolean>(38).fill(false);
  if (state.isOver) return mask;
  mask[PASS] = true;
  for (let call = state.lastBid === null ? BID_OFFSET : state.lastBid + 1; call < 38; call++) {
    mask[call] = true;
  }
  if (state.lastBid !== null && state.lastBidder !== null) {
    const opponentBid = !sameSide(state.lastBidder, state.turn);
    if (!state.doubled && !state.redoubled && opponentBid) mask[DOUBLE] = true;
    if (state.doubled && !state.redoubled && !opponentBid) mask[REDOUBLE] = true;
  }
  return mask;
}

/**
 * Final contract: declarer is the first player of the winning side who bid
 * the final strain.
 */
export function finalContract(dealer: Seat, calls: Call[]): Contract | null {
  const state = auctionState(dealer, calls);
  if (!state.isOver || state.passedOut || state.lastBid === null || state.lastBidder === null) return null;
  const strain: Strain = bidStrain(state.lastBid);
  const side = state.lastBidder % 2;
  let declarer: Seat = state.lastBidder;
  for (let i = 0; i < calls.length; i++) {
    const seat = ((dealer + i) % 4) as Seat;
    if (seat % 2 === side && isBid(calls[i]) && bidStrain(calls[i]) === strain) {
      declarer = seat;
      break;
    }
  }
  return {
    level: bidLevel(state.lastBid),
    strain,
    declarer,
    doubled: state.doubled,
    redoubled: state.redoubled,
  };
}

/**
 * Coarse auction-role buckets for a single call — the "bid type" axis of the
 * stats page's bidding ledger. Deliberately role-based (who opened, relative
 * to the caller) rather than convention-based: SAYC convention names would
 * scatter a player's record across dozens of one-call rows, while these six
 * buckets each collect enough calls to say something about where a player's
 * bidding leaks. Derivable from (dealer, prior calls, call) alone — no hand
 * knowledge — so historical boards classify exactly like new ones.
 */
export type BidCategory = 'opening' | 'response' | 'rebid' | 'overcall' | 'double' | 'pass';

export function bidCategory(dealer: Seat, callsBefore: Call[], call: Call): BidCategory {
  if (call === DOUBLE || call === REDOUBLE) return 'double';
  if (call === PASS) return 'pass';
  const seat = ((dealer + callsBefore.length) % 4) as Seat;
  const openerIndex = callsBefore.findIndex(isBid);
  if (openerIndex < 0) return 'opening';
  const opener = ((dealer + openerIndex) % 4) as Seat;
  if (opener === seat) return 'rebid';
  // Partner opened → every later bid of ours (responses and responder
  // rebids alike) is a response; opponents opened → overcalls, advances,
  // and later competitive bids all land in the overcall bucket.
  return sameSide(opener, seat) ? 'response' : 'overcall';
}

export function applyCall(dealer: Seat, calls: Call[], call: Call): Call[] {
  const state = auctionState(dealer, calls);
  if (!legalCalls(state)[call]) {
    throw new Error(`illegal call ${call} in auction [${calls.join(',')}]`);
  }
  return [...calls, call];
}
