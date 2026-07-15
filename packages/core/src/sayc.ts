import { auctionState } from './auction.js';
import {
  BID_OFFSET,
  Call,
  DOUBLE,
  PASS,
  REDOUBLE,
  Seat,
  Strain,
  STRAIN_SYMBOLS,
  bidLevel,
  bidStrain,
  isBid,
  makeBid,
  sameSide,
} from './types.js';

/**
 * Table-driven SAYC (Standard American Yellow Card) bid explanations at
 * "pamphlet depth". Given the auction so far and a candidate call, returns
 * what that call conventionally means for the seat currently to act.
 *
 * This is teaching material, not a bidding engine: for auction sequences
 * beyond the pamphlet we return an honest generic description or null
 * (the UI then shows "no standard SAYC meaning").
 */
export interface BidMeaning {
  /** short summary, e.g. "Weak two" */
  title: string;
  /** full sentence(s) describing the meaning */
  description: string;
  /** point range as display text, e.g. "15–17 HCP" */
  points?: string;
  /** shape promise as display text, e.g. "exactly 5+ hearts" */
  shapePromise?: string;
  /** true when the call is a recognized artificial/conventional bid */
  artificial?: boolean;
  /** false when we fell back to a generic explanation */
  exact: boolean;
  /**
   * Machine-checkable hand requirements for this call, used by advisor.ts to
   * verify "does this hand actually satisfy what the bid promises". Populated
   * for the well-defined natural families (openings, responses, opener rebids,
   * overcalls); deliberately absent from artificial relays (Stayman, transfers,
   * Blackwood, Gerber, 2♦ waiting) and from doubles/Michaels, whose
   * shortness-plus-support semantics don't fit these simple bounds. Authored in
   * pure HCP: display ranges like "10–12 pts" include distribution points, so
   * minima here sit ~1 HCP below them; maxima are kept as-is (length/shortness
   * only push a hand's value up, never down).
   */
  req?: HandConstraint;
}

export interface HandConstraint {
  minHcp?: number;
  maxHcp?: number;
  /** per-suit length bounds; strain is a suit strain only (0=♣ 1=♦ 2=♥ 3=♠) */
  suits?: { strain: 0 | 1 | 2 | 3; min?: number; max?: number }[];
  /** no singleton or void, at most one doubleton */
  balanced?: boolean;
}

interface Ctx {
  calls: Call[];
  seat: Seat; // seat to act
  dealer: Seat;
  /** calls annotated with absolute seat */
  seq: { seat: Seat; call: Call }[];
  myCalls: Call[];
  partnerCalls: Call[];
  oppCalls: Call[];
  /** first non-pass call of the auction, with seat */
  opening: { seat: Seat; call: Call } | null;
  partnerOpened: boolean;
  iOpened: boolean;
  oppsOpened: boolean;
  partnerLastBid: Call | null;
  myLastBid: Call | null;
  lastBid: Call | null; // highest bid so far
  lastBidBySide: 'ours' | 'theirs' | null;
  interference: boolean; // opponents have acted over our side's opening
}

function buildCtx(dealer: Seat, calls: Call[], seat: Seat): Ctx {
  const seq = calls.map((call, i) => ({ seat: ((dealer + i) % 4) as Seat, call }));
  const mine = (s: Seat) => s === seat;
  const partner = (s: Seat) => s === (seat + 2) % 4;
  const opp = (s: Seat) => !sameSide(s, seat);

  const opening = seq.find((x) => x.call !== PASS) ?? null;
  const bids = seq.filter((x) => isBid(x.call));
  const lastBidEntry = bids.length ? bids[bids.length - 1] : null;
  const lastCall = (pred: (s: Seat) => boolean) => {
    const own = seq.filter((x) => pred(x.seat) && isBid(x.call));
    return own.length ? own[own.length - 1].call : null;
  };

  return {
    calls,
    seat,
    dealer,
    seq,
    myCalls: seq.filter((x) => mine(x.seat)).map((x) => x.call),
    partnerCalls: seq.filter((x) => partner(x.seat)).map((x) => x.call),
    oppCalls: seq.filter((x) => opp(x.seat)).map((x) => x.call),
    opening,
    partnerOpened: opening !== null && partner(opening.seat) && isBid(opening.call),
    iOpened: opening !== null && mine(opening.seat) && isBid(opening.call),
    oppsOpened: opening !== null && opp(opening.seat),
    partnerLastBid: lastCall(partner),
    myLastBid: lastCall(mine),
    lastBid: lastBidEntry ? lastBidEntry.call : null,
    lastBidBySide: lastBidEntry ? (sameSide(lastBidEntry.seat, seat) ? 'ours' : 'theirs') : null,
    interference:
      opening !== null &&
      sameSide(opening.seat, seat) &&
      seq.some((x) => opp(x.seat) && x.call !== PASS),
  };
}

const S = STRAIN_SYMBOLS;

function meaning(
  title: string,
  description: string,
  extra: Partial<BidMeaning> = {},
): BidMeaning {
  return { title, description, exact: true, ...extra };
}

function generic(title: string, description: string, extra: Partial<BidMeaning> = {}): BidMeaning {
  return { title, description, exact: false, ...extra };
}

/** Explain `call` as made by the seat currently to act in (dealer, calls). */
export function explainBid(dealer: Seat, calls: Call[], call: Call): BidMeaning | null {
  const state = auctionState(dealer, calls);
  if (state.isOver) return null;
  const ctx = buildCtx(dealer, calls, state.turn);

  if (call === PASS) return explainPass(ctx);
  if (call === DOUBLE) return explainDouble(ctx);
  if (call === REDOUBLE) return explainRedouble(ctx);
  return explainBidCall(ctx, call);
}

function explainPass(ctx: Ctx): BidMeaning {
  if (!ctx.opening) {
    return meaning('Pass', 'Not enough to open: fewer than 13 points (HCP plus length).', {
      points: '0–12 pts',
      req: { maxHcp: 12 },
    });
  }
  if (ctx.partnerOpened && ctx.myCalls.every((c) => c === PASS) && ctx.partnerCalls.length === 1) {
    return meaning('Pass', 'Fewer than 6 points — too weak to respond to partner’s opening.', {
      points: '0–5 pts',
      req: { maxHcp: 5 },
    });
  }
  return generic('Pass', 'Nothing more to say: no extra strength or shape worth showing at this point.');
}

function explainDouble(ctx: Ctx): BidMeaning {
  const last = ctx.lastBid;
  if (last === null) return generic('Double', 'No bid to double.');
  const level = bidLevel(last);
  const strain = bidStrain(last);

  // Negative double: partner opened a suit, RHO overcalled a suit ≤ 2♠
  if (
    ctx.partnerOpened &&
    ctx.opening &&
    bidStrain(ctx.opening.call) !== 4 &&
    ctx.lastBidBySide === 'theirs' &&
    strain !== 4 &&
    last <= makeBid(2, 3)
  ) {
    return meaning(
      'Negative double',
      'Takeout of the overcall: shows the unbid major(s) (typically exactly 4 cards) and enough points to compete — about 6+ at the one level, 8+ at the two level. Partner is asked to pick a suit.',
      { points: '6+ pts', artificial: true },
    );
  }

  // Takeout double: their side opened, low level, we haven't bid
  if (
    ctx.oppsOpened &&
    ctx.lastBidBySide === 'theirs' &&
    level <= 3 &&
    strain !== 4 &&
    ctx.myCalls.every((c) => c === PASS) &&
    ctx.partnerCalls.every((c) => c === PASS)
  ) {
    return meaning(
      'Takeout double',
      `Asks partner to bid their best unbid suit. Shows opening values (13+ points, or a bit less with perfect shape), shortness in ${S[strain]}, and support for the unbid suits.`,
      { points: '13+ pts (or 11–12 with ideal shape)', artificial: true },
    );
  }

  if (strain === 4 || level >= 4) {
    return meaning('Penalty double', 'Suggests defending: you expect to beat their contract.', {});
  }
  return generic(
    'Double',
    'In a competitive auction this is usually takeout-oriented at low levels (asking partner to bid) and penalty-oriented at high levels.',
  );
}

function explainRedouble(ctx: Ctx): BidMeaning {
  if (ctx.partnerOpened || ctx.iOpened) {
    return meaning(
      'Redouble',
      'Shows a strong hand (10+ HCP) after the opponents double. Suggests your side owns the hand; later doubles by your side are for penalty.',
      { points: '10+ HCP' },
    );
  }
  return generic('Redouble', 'Rare: either strength or an SOS asking partner to run to another suit.');
}

function explainBidCall(ctx: Ctx, call: Call): BidMeaning | null {
  const level = bidLevel(call);
  const strain = bidStrain(call);

  // ----- Opening bids -----
  if (!ctx.opening) return explainOpening(level, strain);

  // ----- Conventions recognized by exact context -----
  const conventional = explainConventions(ctx, call, level, strain);
  if (conventional) return conventional;

  // ----- Responding to partner's opening (no interference) -----
  if (ctx.partnerOpened && ctx.myCalls.every((c) => c === PASS) && !ctx.interference) {
    return explainResponse(ctx, call, level, strain);
  }

  // ----- Opener's rebid -----
  if (ctx.iOpened && ctx.myCalls.filter((c) => c !== PASS).length === 1 && !ctx.interference) {
    return explainOpenerRebid(ctx, call, level, strain);
  }

  // ----- Overcalls (their side opened, our side silent so far) -----
  if (
    ctx.oppsOpened &&
    ctx.myCalls.every((c) => c === PASS) &&
    ctx.partnerCalls.every((c) => c === PASS)
  ) {
    return explainOvercall(ctx, call, level, strain);
  }

  // ----- Generic continuations -----
  return explainContinuation(ctx, call, level, strain);
}

function explainOpening(level: number, strain: Strain): BidMeaning | null {
  if (level === 1) {
    if (strain === 4)
      return meaning('1NT opening', 'A balanced hand (no singleton or void, at most one doubleton) with 15–17 HCP.', {
        points: '15–17 HCP',
        shapePromise: 'balanced',
        req: { minHcp: 15, maxHcp: 17, balanced: true },
      });
    if (strain >= 2)
      return meaning(
        `1${S[strain]} opening`,
        `Opening hand with a 5-card or longer ${S[strain]} suit. With two 5-card suits open the higher-ranking.`,
        { points: '13–21 pts', shapePromise: `5+ ${S[strain]}`, req: { minHcp: 12, maxHcp: 21, suits: [{ strain, min: 5 }] } },
      );
    return meaning(
      `1${S[strain]} opening`,
      `Opening hand without a 5-card major: your longer minor, ${
        strain === 0 ? 'possibly only 3 clubs ("could be short")' : '3 cards only when exactly 3–3 in the minors is impossible — usually 4+'
      }.`,
      { points: '13–21 pts', shapePromise: `3+ ${S[strain]}`, req: { minHcp: 12, maxHcp: 21, suits: [{ strain, min: 3 }] } },
    );
  }
  if (level === 2) {
    if (strain === 0)
      return meaning(
        '2♣ opening',
        'Strong and artificial — says nothing about clubs. Almost game-forcing: 22+ HCP, or a hand within one trick of game. Partner must respond (2♦ is the usual "waiting" reply).',
        { points: '22+ pts', artificial: true, req: { minHcp: 21 } },
      );
    if (strain === 4)
      return meaning('2NT opening', 'A balanced 20–21 HCP. Not forcing; partner may pass with a very weak hand.', {
        points: '20–21 HCP',
        shapePromise: 'balanced',
        req: { minHcp: 20, maxHcp: 21, balanced: true },
      });
    return meaning(
      `Weak two: 2${S[strain]}`,
      `A preempt: a good 6-card ${S[strain]} suit and 5–11 HCP, below an opening hand. Takes bidding space from the opponents.`,
      { points: '5–11 HCP', shapePromise: `good 6-card ${S[strain]}`, req: { minHcp: 5, maxHcp: 11, suits: [{ strain, min: 6 }] } },
    );
  }
  if (level === 3) {
    if (strain === 4)
      return meaning('3NT opening', 'A balanced powerhouse: 25–27 HCP.', {
        points: '25–27 HCP',
        shapePromise: 'balanced',
        req: { minHcp: 25, maxHcp: 27, balanced: true },
      });
    return meaning(
      `Preempt: 3${S[strain]}`,
      `A weak hand with a 7-card ${S[strain]} suit — obstruction, roughly "within 2–3 tricks of your bid". Usually 5–10 HCP with most strength in the suit.`,
      { points: '5–10 HCP', shapePromise: `7-card ${S[strain]}`, req: { minHcp: 5, maxHcp: 10, suits: [{ strain, min: 7 }] } },
    );
  }
  if (level === 4 && strain !== 4) {
    return meaning(
      `Preempt: 4${S[strain]}`,
      `A weak hand with a long, strong ${S[strain]} suit (usually 8 cards) — you expect to take about 8 tricks with ${S[strain]} as trumps and little defense.`,
      { points: '5–10 HCP', shapePromise: `8-card ${S[strain]}`, req: { minHcp: 5, maxHcp: 10, suits: [{ strain, min: 8 }] } },
    );
  }
  return generic(
    `${level}${S[strain]} opening`,
    'Not a standard SAYC opening — very rare; shows a highly distributional hand willing to play here.',
  );
}

/** Conventions keyed off exact sequences: Stayman, transfers, Blackwood, Gerber. */
function explainConventions(ctx: Ctx, call: Call, level: number, strain: Strain): BidMeaning | null {
  const partnerBid = ctx.partnerLastBid;

  // --- over partner's 1NT / 2NT / 3NT OPENING (not a later NT bid like Blackwood) ---
  const overNT =
    ctx.partnerOpened &&
    partnerBid !== null &&
    ctx.opening !== null &&
    ctx.opening.call === partnerBid &&
    bidStrain(partnerBid) === 4 &&
    ctx.lastBid === partnerBid &&
    !ctx.interference;
  if (overNT && partnerBid !== null) {
    const ntLevel = bidLevel(partnerBid);
    if (level === ntLevel + 1 && strain === 0) {
      return meaning(
        'Stayman',
        `Artificial: asks partner for a 4-card major. Use with at least one 4-card major and ${
          ntLevel === 1 ? 'invitational values (8+ HCP)' : 'game interest'
        }. Partner answers ${ntLevel + 1}♦ with no 4-card major.`,
        { points: ntLevel === 1 ? '8+ HCP' : '4+ HCP', artificial: true },
      );
    }
    if (level === ntLevel + 1 && (strain === 1 || strain === 2)) {
      const major = strain === 1 ? '♥' : '♠';
      return meaning(
        `Jacoby transfer to ${major}`,
        `Artificial: shows 5+ ${major} and asks partner to bid ${ntLevel + 1}${major}. Any strength — you may pass the transfer with a weak hand, or continue toward game/slam.`,
        { points: 'any', shapePromise: `5+ ${major}`, artificial: true },
      );
    }
    if (ntLevel === 1 && call === makeBid(2, 3)) {
      return generic(
        '2♠ over 1NT',
        'Not part of core SAYC (spade hands go through the 2♥ transfer). Some pairs use it as a minor-suit signoff — agree with your partner; treat as natural and weak by default.',
      );
    }
    if (level === ntLevel + 1 && strain === 4) {
      return meaning(
        `${level}NT invitation`,
        `Invites game: partner passes with a minimum and bids ${level + 1}NT with a maximum. Denies a 4-card major (no Stayman used).`,
        { points: ntLevel === 1 ? '8–9 HCP' : '4–5 HCP', shapePromise: 'balanced' },
      );
    }
    if (strain === 0 && level === 4) {
      return meaning(
        'Gerber',
        'Artificial ace-ask over NT: partner answers 4♦ = 0 or 4 aces, 4♥ = 1, 4♠ = 2, 4NT = 3.',
        { artificial: true },
      );
    }
    if (strain === 4 && level === 4) {
      return meaning(
        'Quantitative 4NT',
        `Invites slam in notrump: asks partner to bid 6NT with a maximum, pass with a minimum. (Not Blackwood — no suit is agreed.)`,
        { points: ntLevel === 1 ? '16–17 HCP' : '11–12 HCP', shapePromise: 'balanced' },
      );
    }
    if (strain === 4 && level === 3) {
      return meaning('3NT signoff', 'To play: enough for game opposite partner’s notrump opening, no interest in a major fit.', {
        points: ntLevel === 1 ? '10–15 HCP' : '5–10 HCP',
      });
    }
  }

  // --- Blackwood 4NT after suit bidding ---
  if (call === makeBid(4, 4) && ctx.lastBid !== null && bidStrain(ctx.lastBid) !== 4) {
    return meaning(
      'Blackwood 4NT',
      'Asks partner how many aces they hold: 5♣ = 0 or 4, 5♦ = 1, 5♥ = 2, 5♠ = 3. Used when your side has agreed a trump suit and is investigating slam.',
      { artificial: true },
    );
  }

  // --- Blackwood responses ---
  if (
    ctx.partnerLastBid === makeBid(4, 4) &&
    ctx.lastBid === makeBid(4, 4) &&
    level === 5 &&
    strain <= 3
  ) {
    const aces = ['0 or 4', '1', '2', '3'][strain];
    return meaning(`Blackwood response: 5${S[strain]}`, `Artificial answer to 4NT: shows ${aces} ace${aces === '1' ? '' : 's'}.`, {
      artificial: true,
    });
  }

  // --- 2♦ waiting after 2♣ ---
  if (
    ctx.partnerOpened &&
    ctx.opening?.call === makeBid(2, 0) &&
    call === makeBid(2, 1) &&
    ctx.myCalls.every((c) => c === PASS) &&
    !ctx.interference
  ) {
    return meaning(
      '2♦ waiting',
      'Artificial, says nothing about diamonds: the normal response to partner’s strong 2♣, waiting to hear opener’s real suit. A direct suit bid instead would show a good 5+ card suit and 8+ points.',
      { points: 'any', artificial: true },
    );
  }

  // --- 2NT ask over partner's weak two ---
  if (
    ctx.partnerOpened &&
    ctx.opening !== null &&
    isBid(ctx.opening.call) &&
    bidLevel(ctx.opening.call) === 2 &&
    bidStrain(ctx.opening.call) >= 1 &&
    bidStrain(ctx.opening.call) <= 3 &&
    call === makeBid(2, 4) &&
    !ctx.interference &&
    ctx.myCalls.every((c) => c === PASS)
  ) {
    return meaning(
      '2NT over a weak two',
      'Forcing enquiry: asks opener to show an outside feature (ace or king) with a maximum, or rebid the suit with a minimum. Shows game interest (about 15+ points).',
      { points: '15+ pts', artificial: true },
    );
  }

  return null;
}

function explainResponse(ctx: Ctx, call: Call, level: number, strain: Strain): BidMeaning | null {
  const opening = ctx.opening!.call;
  const openLevel = bidLevel(opening);
  const openStrain = bidStrain(opening);

  if (openLevel === 1 && openStrain !== 4) {
    // raises
    if (strain === openStrain) {
      const major = openStrain >= 2;
      if (level === 2)
        return meaning(
          `Single raise`,
          `Simple raise of partner's suit: ${major ? '3+ card support' : '4+ card support (minors are often raised with 5)'} and 6–10 points.`,
          {
            points: '6–10 pts',
            shapePromise: `${major ? '3+' : '4+'} ${S[openStrain]}`,
            req: { minHcp: 5, maxHcp: 10, suits: [{ strain: openStrain, min: major ? 3 : 4 }] },
          },
        );
      if (level === 3)
        return meaning(
          `Limit raise`,
          `Invitational jump raise: ${major ? '3+' : '4+'} card support and 10–12 points. Partner bids game with better than a minimum opening.`,
          {
            points: '10–12 pts',
            shapePromise: `${major ? '3+' : '4+'} ${S[openStrain]}`,
            req: { minHcp: 9, maxHcp: 12, suits: [{ strain: openStrain, min: major ? 3 : 4 }] },
          },
        );
      if (level === 4 && major)
        return meaning(
          `Raise to game`,
          'Preemptive-to-practical: 5+ card support with a shapely, weakish hand (not a strong slam try — strong hands go slower).',
          {
            points: '~6–12 pts',
            shapePromise: `5+ ${S[openStrain]}`,
            req: { minHcp: 5, maxHcp: 12, suits: [{ strain: openStrain, min: 5 }] },
          },
        );
    }
    // 1NT response
    if (call === makeBid(1, 4))
      return meaning(
        '1NT response',
        'A catch-all: 6–10 points, no suit you can show at the one level, not enough to bid at the two level.',
        { points: '6–10 pts', req: { minHcp: 5, maxHcp: 10 } },
      );
    // 2NT / 3NT responses
    if (call === makeBid(2, 4))
      return meaning('2NT response', 'Balanced 13–15 points without a fit — forcing to game in SAYC.', {
        points: '13–15 HCP',
        shapePromise: 'balanced',
        req: { minHcp: 13, maxHcp: 15, balanced: true },
      });
    if (call === makeBid(3, 4))
      return meaning('3NT response', 'Balanced 16–18 points without a fit.', {
        points: '16–18 HCP',
        shapePromise: 'balanced',
        req: { minHcp: 16, maxHcp: 18, balanced: true },
      });
    // new suits
    if (strain !== openStrain && strain !== 4) {
      // Minimum available level for this suit; +1 above it is a jump, +2 a double jump.
      const minLevel = openLevel + (strain > openStrain ? 0 : 1);
      // Splinter: a double jump in a new suit over a major opening — game-forcing
      // raise with shortness. Not in the SAYC pamphlet proper, but a near-universal
      // extension that the robot's system plays. Majors only for now: over minor
      // openings splinters collide with inverted-minor treatments and we haven't
      // verified the model bids them.
      if (openStrain >= 2 && level === minLevel + 2)
        return meaning(
          'Splinter raise',
          `Double jump in a new suit: a game-forcing raise with 4+ ${S[openStrain]} and a singleton or void in ${S[strain]}. A near-universal SAYC extension (not in the pamphlet proper) — the robot plays it.`,
          {
            points: '10–13 pts',
            shapePromise: `4+ ${S[openStrain]}, singleton/void ${S[strain]}`,
            artificial: true,
            req: { minHcp: 9, maxHcp: 14, suits: [{ strain: openStrain, min: 4 }, { strain, max: 1 }] },
          },
        );
      if (level === minLevel + 1)
        return meaning(
          'Jump shift',
          `A strong jump in a new suit: 17+ points with a good 5+ card ${S[strain]} suit. Game forcing, suggests slam.`,
          { points: '17+ pts', shapePromise: `5+ ${S[strain]}`, req: { minHcp: 16, suits: [{ strain, min: 5 }] } },
        );
      if (level === 1)
        return meaning(
          `New suit at the 1 level`,
          `Natural and forcing one round: 4+ ${S[strain]} and 6+ points. Opener must bid again.`,
          { points: '6+ pts', shapePromise: `4+ ${S[strain]}`, req: { minHcp: 5, suits: [{ strain, min: 4 }] } },
        );
      if (level === minLevel)
        return meaning(
          `New suit at the 2 level`,
          `Natural and forcing: ${strain === 2 && openStrain === 3 ? '5+' : '4+'} ${S[strain]} and 10+ points (SAYC two-over-one shows real values).`,
          {
            points: '10+ pts',
            shapePromise: `${strain === 2 && openStrain === 3 ? '5+' : '4+'} ${S[strain]}`,
            req: { minHcp: 10, suits: [{ strain, min: strain === 2 && openStrain === 3 ? 5 : 4 }] },
          },
        );
      // triple jumps and beyond fall through to the honest generic below
    }
  }

  if (opening === makeBid(2, 0)) {
    if (strain !== 4)
      return meaning(
        `Positive response`,
        `Natural and positive opposite the strong 2♣: a good 5+ card ${S[strain]} suit and 8+ points. (With less, respond 2♦ waiting.)`,
        { points: '8+ pts', shapePromise: `5+ ${S[strain]}`, req: { minHcp: 7, suits: [{ strain, min: 5 }] } },
      );
    return meaning('2NT positive', 'Balanced 8+ points opposite the strong 2♣ opening.', {
      points: '8+ HCP',
      shapePromise: 'balanced',
      req: { minHcp: 8, balanced: true },
    });
  }

  // responses to weak twos / preempts
  if (openLevel >= 2 && openStrain !== 4) {
    if (strain === openStrain)
      return meaning(
        'Raise of the preempt',
        'Extends the preempt ("raise only non-force") — partner is expected to pass. Bid to the level your combined trumps justify.',
        { points: 'varies', shapePromise: `${S[openStrain]} support` },
      );
    if (strain !== 4)
      return meaning(
        'New suit over the preempt',
        `Natural and forcing: a good 5+ card ${S[strain]} suit and interest in game.`,
        { points: '15+ pts', shapePromise: `5+ ${S[strain]}`, req: { minHcp: 14, suits: [{ strain, min: 5 }] } },
      );
    if (strain === 4 && level === 3)
      return meaning('3NT over the preempt', 'To play: stoppers in the unbid suits and expectation of nine tricks (often with a fit or source of tricks).', {
        points: '~15+ pts',
        req: { minHcp: 14 },
      });
  }

  return generic(
    `${level}${S[strain]}`,
    'A natural continuation; exact ranges in this sequence are beyond the SAYC pamphlet.',
  );
}

function explainOpenerRebid(ctx: Ctx, call: Call, level: number, strain: Strain): BidMeaning | null {
  const opening = ctx.opening!.call;
  const openStrain = bidStrain(opening);
  const openLevel = bidLevel(opening);
  const response = ctx.partnerLastBid;
  if (response === null || openLevel !== 1) {
    return explainContinuation(ctx, call, level, strain);
  }

  if (openStrain !== 4) {
    if (strain === 4) {
      if (level === 1)
        return meaning('1NT rebid', 'A balanced minimum that opened a suit: 12–14 HCP, no fit for partner, no second suit worth showing.', {
          points: '12–14 HCP',
          shapePromise: 'balanced',
          req: { minHcp: 12, maxHcp: 14, balanced: true },
        });
      if (level === 2 && call > response + 4)
        return meaning('2NT jump rebid', 'A balanced 18–19 HCP — too strong to open 1NT.', {
          points: '18–19 HCP',
          shapePromise: 'balanced',
          req: { minHcp: 18, maxHcp: 19, balanced: true },
        });
    }
    if (strain === openStrain) {
      const jump = level >= bidLevel(response) + (strain > bidStrain(response) ? 1 : 2);
      if (jump)
        return meaning('Jump rebid of your suit', `A good 6+ card ${S[strain]} suit with 16–18 points — invitational.`, {
          points: '16–18 pts',
          shapePromise: `6+ ${S[strain]}`,
          req: { minHcp: 15, maxHcp: 18, suits: [{ strain, min: 6 }] },
        });
      return meaning('Rebid of your suit', `A minimum opening with a 6+ card ${S[strain]} suit and nothing better to say.`, {
        points: '13–15 pts',
        shapePromise: `6+ ${S[strain]}`,
        req: { minHcp: 12, maxHcp: 15, suits: [{ strain, min: 6 }] },
      });
    }
    if (isBid(response) && strain === bidStrain(response)) {
      const jump = level > bidLevel(response) + 1;
      if (jump)
        return meaning('Jump raise of responder', `4-card support for partner's suit with 17–18 points — invitational to game.`, {
          points: '17–18 pts',
          shapePromise: `4 ${S[strain]}`,
          req: strain !== 4 ? { minHcp: 16, maxHcp: 18, suits: [{ strain, min: 4 }] } : { minHcp: 16, maxHcp: 18 },
        });
      return meaning('Raise of responder', `4-card support for partner's suit with a minimum-range opening (13–16 points).`, {
        points: '13–16 pts',
        shapePromise: `4 ${S[strain]}`,
        req: strain !== 4 ? { minHcp: 12, maxHcp: 16, suits: [{ strain, min: 4 }] } : { minHcp: 12, maxHcp: 16 },
      });
    }
    if (strain !== 4 && strain !== openStrain) {
      // reverse detection: new suit at 2-level higher-ranking than opened suit
      const isReverse = level === 2 && strain > openStrain && isBid(response) && bidLevel(response) < 2;
      const isJumpShift = level >= 3 || (level === 2 && isBid(response) && call > response + 5);
      if (isJumpShift)
        return meaning('Jump shift by opener', 'A very strong two-suiter: about 19+ points. Game forcing.', {
          points: '19+ pts',
          shapePromise: `4+ ${S[strain]}`,
          req: { minHcp: 18, suits: [{ strain, min: 4 }] },
        });
      if (isReverse)
        return meaning(
          'Reverse',
          `A new suit at the two level above your first suit: shows 17+ points and at least 5–4 shape (first suit longer). Forcing one round.`,
          {
            points: '17+ pts',
            shapePromise: `4+ ${S[strain]}, longer ${S[openStrain]}`,
            req: { minHcp: 16, suits: [{ strain, min: 4 }] },
          },
        );
      return meaning('New suit rebid', `Natural: 4+ ${S[strain]}, typically an unbalanced opening (13–18 points). Not forcing.`, {
        points: '13–18 pts',
        shapePromise: `4+ ${S[strain]}`,
        req: { minHcp: 12, maxHcp: 18, suits: [{ strain, min: 4 }] },
      });
    }
  }
  return explainContinuation(ctx, call, level, strain);
}

function explainOvercall(ctx: Ctx, call: Call, level: number, strain: Strain): BidMeaning | null {
  const theirBid = ctx.lastBid;
  if (theirBid === null) return null;

  // cue bid of their suit = Michaels
  if (strain !== 4 && strain === bidStrain(theirBid) && level === bidLevel(theirBid) + 1) {
    const theirStrain = bidStrain(theirBid);
    const shows =
      theirStrain >= 2
        ? `both 5+ ${S[5 - theirStrain]} and a 5+ minor`
        : '5+ cards in each major';
    return meaning('Michaels cue-bid', `Artificial two-suiter: ${shows}, typically 8–15 points (weak or strong, rarely in between).`, {
      points: '8+ pts',
      shapePromise: shows,
      artificial: true,
    });
  }

  if (strain === 4) {
    if (level === 1)
      return meaning('1NT overcall', 'Like a strong notrump opening: 15–18 HCP, balanced, with at least one stopper in their suit.', {
        points: '15–18 HCP',
        shapePromise: 'balanced, stopper in their suit',
        req: { minHcp: 15, maxHcp: 18, balanced: true },
      });
    return generic(`${level}NT overcall`, 'Unusual notrump territory: typically shows the two lowest unbid suits (5–5).', {
      artificial: true,
    });
  }

  const minLevel = theirBid < makeBid(1, strain) ? 1 : 2;
  const isJump = level > (strain > bidStrain(theirBid) ? bidLevel(theirBid) : bidLevel(theirBid) + 1);
  if (isJump)
    return meaning('Weak jump overcall', `Preemptive, like a weak two/three opening: a good 6+ card ${S[strain]} suit, 5–11 HCP.`, {
      points: '5–11 HCP',
      shapePromise: `6+ ${S[strain]}`,
      req: { minHcp: 5, maxHcp: 11, suits: [{ strain, min: 6 }] },
    });
  if (level === 1)
    return meaning('One-level overcall', `Natural: a decent 5+ card ${S[strain]} suit and about 8–16 points.`, {
      points: '8–16 pts',
      shapePromise: `5+ ${S[strain]}`,
      req: { minHcp: 7, maxHcp: 16, suits: [{ strain, min: 5 }] },
    });
  return meaning('Two-level overcall', `Natural: a good 5+ card ${S[strain]} suit and opening-ish values, about 10–16 points.`, {
    points: '10–16 pts',
    shapePromise: `5+ ${S[strain]}`,
    req: { minHcp: 9, maxHcp: 16, suits: [{ strain, min: 5 }] },
  });
}

function explainContinuation(ctx: Ctx, call: Call, level: number, strain: Strain): BidMeaning {
  // Support for partner's suit
  if (ctx.partnerLastBid !== null && isBid(ctx.partnerLastBid) && strain === bidStrain(ctx.partnerLastBid) && strain !== 4) {
    return generic(`Raise to ${level}${S[strain]}`, `Agrees ${S[strain]} as trumps and invites or sets the level based on combined strength.`, {
      shapePromise: `${S[strain]} support`,
    });
  }
  if (ctx.myLastBid !== null && isBid(ctx.myLastBid) && strain === bidStrain(ctx.myLastBid) && strain !== 4) {
    return generic(`Rebid of ${S[strain]}`, `Extra length in ${S[strain]} (usually 6+ cards).`, {
      shapePromise: `6+ ${S[strain]}`,
    });
  }
  if (strain === 4) {
    if (level === 3) return generic('3NT', 'Offers to play game in notrump: stoppers in the unbid suits and enough combined strength (~25 HCP).');
    return generic(`${level}NT`, 'Natural notrump: balanced values with stoppers, proposing to play here or inviting more.');
  }
  return generic(`${level}${S[strain]}`, `Natural: length in ${S[strain]}. Exact ranges in this sequence are beyond the SAYC pamphlet.`);
}
