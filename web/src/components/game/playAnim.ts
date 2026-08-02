import type { AuctionEntry, BoardView, TrickCard } from '../../api';
import { cardRank, cardSuit } from '../../api';

/**
 * Play and auction animation support: turns one server board transition into
 * a timed sequence of intermediate views, so the table plays out one card (or
 * one call) at a time instead of jumping straight to the final state.
 *
 * The server resolves a whole burst of robot actions per request
 * (advanceRobots runs until it's the human's turn again), so the response can
 * contain: the human's card, the robot cards that finished the trick, a trick
 * boundary, and the robot leads of the next trick. stagePlaySteps
 * reconstructs that burst as snapshots; Board.tsx applies them on timers, and
 * TrickArea animates each diff (glide-in, collect sweep, tally stamp) as the
 * snapshots land. stageBidSteps does the same for a bidding burst — up to
 * three robot calls per response, which otherwise all appeared in one frame.
 * Everything here is pure and unit-tested; the DOM work lives in TrickArea
 * and (for a call landing on the tray) one CSS keyframe on AuctionGrid.
 */

// Timing (ms) — approved in the design mockup: a 260ms ease-out glide per
// card, robots "think" between plays, and a completed trick holds on the
// table before the collect sweep.
export const GLIDE_MS = 260;
export const ROBOT_GAP_MS = 450;
export const HOLD_MS = 300;
export const COLLECT_MS = 260;
export const STAMP_MS = 420;

// A forced (single-legal-card) turn auto-plays after this delay — just long
// enough to register as a deliberate play (not an instant jump) without
// making the player wait to see a card they had no choice over.
export const AUTO_PLAY_DELAY_MS = 250;

// One robot CALL at a time. A call has no flight to animate — only the
// auction cell's own drop-in — so this beat is the whole event rather than a
// gap after one, and it is READING time: a call is a sentence in a language
// the player may still be learning ("2♠ over my 1♣ — that's an overcall"),
// which is a slower thing to take in than watching a card land on the felt.
// So it sits just under a robot card's GLIDE_MS + ROBOT_GAP_MS = 710ms while
// carrying more to read — tried at 420 (too quick to digest) and 840 (a
// noticeable wait for three replies) before landing here. Three robot
// replies cost ~2s, and this is the one number to move if the reveal ever
// reads as either.
export const BID_GAP_MS = 650;

// The call that ends the auction changes the entire screen — bid dock out,
// trick area and dummy in — so it holds longer still before the table turns
// over. Derived rather than written as a literal: it has to stay the HEAVIER
// beat, and the one time these were tuned independently the per-call gap
// doubled straight past a hardcoded value and silently inverted them.
export const AUCTION_END_MS = Math.round(BID_GAP_MS * 1.25);

// The "Fast forward settled tricks" ON pacing: much shorter than
// ROBOT_GAP_MS/HOLD_MS+STAMP_MS since a claim can span many tricks — the
// glide/collect beats themselves (GLIDE_MS/COLLECT_MS) are untouched, only
// the gaps between them compress (and compress further still under
// CLAIM_SPEEDUP_FACTOR, see below). No separate hold beat or terminal stamp
// needed. OFF pacing reuses stagePlaySteps' own ordinary-play gaps instead
// (ROBOT_GAP_MS/HOLD_MS/COLLECT_MS/STAMP_MS) — see stageClaimSteps.
export const CLAIM_GAP_MS = 130;
export const CLAIM_TRICK_GAP_MS = 110;

// Board.tsx no longer starts the fast-forward the instant a claim is
// detected: the announcement (ClaimOverlay) holds the board for this long —
// tap/click/Escape dismisses early — so the "N/S CLAIM n REMAINING TRICKS"
// news can't be missed the way it could when it merely popped up alongside
// cards already in motion. Applies uniformly whether or not motion is on:
// without WAAPI (reduced-motion, or no support) there's no fast-forward to
// animate afterward, but the announcement still deserves its full, deliberate
// read before Board.tsx jumps straight to the result.
export const CLAIM_ANNOUNCE_HOLD_MS = 2000;

// ...and the announcement itself waits for the tricks that are NOT part of
// the claim (see claimAnnouncement's `priorTricks`) to be paid first. This is
// the beat between that last trick collecting and the overlay covering the
// board: TrickArea holds its `.stamp` class for 500ms driving a 0.42s
// stamp-pop, so without it React batches the collect and the modal into one
// commit and the trick the human just won is technically on screen and
// perceptually not. Applies whether or not motion is on, same reasoning as
// CLAIM_ANNOUNCE_HOLD_MS: with no animation to wait out there is still a
// number that just changed and deserves to be read.
export const CLAIM_LEAD_SETTLE_MS = 500;

// Once the announcement is dismissed, the fast-forward itself runs 33%
// faster than its base pacing above: scaling every gap's duration by 3/4
// raises speed by 4/3 (⅓ = 33.3%), so this is applied directly to
// stageClaimSteps' computed delays rather than approximated. Only the gaps
// scale — GLIDE_MS/COLLECT_MS (TrickArea's own WAAPI durations) are shared
// with ordinary play and stay untouched, same reasoning as the base pacing
// above.
export const CLAIM_SPEEDUP_FACTOR = 0.75;

export interface StagedStep {
  /** delay in ms after the previous step (0 = apply immediately) */
  delayBefore: number;
  view: BoardView;
}

/** True when we can (and should) animate: WAAPI present, no reduced-motion. */
export function motionOK(): boolean {
  if (typeof window === 'undefined' || typeof Element === 'undefined') return false;
  if (typeof Element.prototype.animate !== 'function') return false; // jsdom
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }
  return true;
}

// ---- fan → trick-slot flight origins ----
// HandFan records where a card was when the user confirmed it; TrickArea
// consumes the rect so the glide starts from the tapped card instead of
// off-table. Keyed by card int (cards are unique per board).

const playOrigins = new Map<number, { rect: DOMRect; at: number }>();

export function capturePlayOrigin(card: number, rect: DOMRect): void {
  playOrigins.set(card, { rect, at: Date.now() });
}

/** One-shot: returns and clears the recorded origin, if it's still fresh. */
export function takePlayOrigin(card: number): DOMRect | null {
  const hit = playOrigins.get(card);
  playOrigins.delete(card);
  if (!hit || Date.now() - hit.at > 10_000) return null;
  return hit.rect;
}

/**
 * Cards played without ever being tapped — the auto-play timer's forced
 * card, and every card in a claim's fast-forward — never go through
 * HandFan's onClick, so capturePlayOrigin is never called for them and
 * TrickArea's glideIn falls back to an off-table origin. That's correct for
 * an opponent's card (it was never visible to begin with), but wrong for
 * the human's OWN hand or a top-fan dummy: those cards sit in a visible
 * fan the whole time (handAt/dummyHandAt keep them there until their staged
 * step), so they should glide from wherever they currently are, exactly
 * like a real tap. Board.tsx calls this just before applying each staged
 * step, for whichever card is newly appearing in that step — a no-op if an
 * origin was already captured some other way (a real tap, or the auto-play
 * timer), since it only fills in a gap, never overrides one.
 */
export function captureFanOriginIfVisible(view: BoardView, play: TrickCard): void {
  if (playOrigins.has(play.card) || typeof document === 'undefined') return;
  const isBottomFan = play.seat === (view.playingSeat ?? 2);
  const isTopFan = play.seat === view.dummy && view.dummy !== 1 && view.dummy !== 3; // not the E/W dummy rail
  if (!isBottomFan && !isTopFan) return;
  const el = document.querySelector<HTMLElement>(`[data-card="${play.card}"]`);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0) capturePlayOrigin(play.card, rect);
}

// ---- trick winner (mirrors @bridge/core play.ts trickWinner) ----

/** strain 0=♣ 1=♦ 2=♥ 3=♠ 4=NT; suits 0=♠ 1=♥ 2=♦ 3=♣ */
const trumpSuit = (strain: number): number | null => (strain === 4 ? null : 3 - strain);

export function trickWinner(trick: TrickCard[], strain: number): number {
  const trump = trumpSuit(strain);
  let best = trick[0];
  for (const play of trick.slice(1)) {
    const suit = cardSuit(play.card);
    const bestSuit = cardSuit(best.card);
    if (trump !== null && suit === trump && bestSuit !== trump) {
      best = play;
    } else if (suit === bestSuit && cardRank(play.card) > cardRank(best.card)) {
      best = play;
    }
  }
  return best.seat;
}

// ---- staging ----

const sameCards = (a: TrickCard[], b: TrickCard[]) =>
  a.length === b.length && a.every((t, i) => t.card === b[i].card && t.seat === b[i].seat);

/**
 * Every intermediate snapshot (ordinary play or a claim's fast-forward)
 * renders as a locked play phase — shared by stagePlaySteps and
 * stageClaimSteps so the "what does a mid-animation view look like" contract
 * can't drift between the two.
 */
const lockedView = (next: BoardView, over: Partial<BoardView>): BoardView => ({
  ...next,
  state: 'playing',
  myTurn: false,
  legalCards: undefined,
  ...over,
});

/**
 * A mid-auction snapshot: PREV's board with one more call on the tray.
 *
 * Built from `prev`, not `next`, on purpose — the twin above can use `next`
 * because a play-phase burst starts and ends in the play phase, but a bidding
 * burst can END the auction, and by then `next` is a play-phase view carrying
 * a contract, a dummy, a reduced hand, and (on a board partner declares) the
 * NORTH seat's hand and HCP. BiddingPhase renders board.hand and board.hcp,
 * so re-labelling one of those `state: 'bidding'` would flash the wrong hand
 * under the last call. The only thing that legitimately changes during a
 * bidding burst is the auction.
 *
 * `legalCalls` is deliberately NOT cleared, which is the one place this
 * diverges from lockedView's "blank what the human could act on". Those calls
 * are what size the bid box (BidBox windows itself to the levels still
 * biddable), and the box is DOCKED so the hand and the feedback above it hug
 * its top edge — swap it for something shorter and that whole cluster slides
 * down the screen and back on every turn. So the box stays, rendered inert:
 * `myTurn: false` is what BiddingPhase reads to lock it and say the robots
 * are thinking, and nothing can be submitted from it meanwhile.
 */
const lockedBidView = (prev: BoardView, auction: AuctionEntry[]): BoardView => ({
  ...prev,
  state: 'bidding',
  myTurn: false,
  auction,
});

/**
 * The view to show the INSTANT a card is tapped, before the server answers.
 *
 * Board.tsx used to await POST /play before rendering anything, so the whole
 * round trip — measured p50 64ms / p90 173ms against production hardware, and
 * longer on a cold machine — was dead time in which the tapped card simply sat
 * in the fan. Nothing about that wait is needed to draw the human's OWN card:
 * `legalCards` came from the server, so it has already ruled the card legal,
 * and the server is deterministic about where it lands. What the response
 * actually carries is the ROBOTS' replies, and stagePlaySteps was always going
 * to hold those back a beat anyway (GLIDE_MS + ROBOT_GAP_MS = 710ms after the
 * human's card), so the round trip now hides inside a gap the animation was
 * going to spend regardless — see trimStagedPrefix for the bookkeeping.
 *
 * This predicts ONLY the human's own card: one card into the trick, out of
 * whichever fan it came from, turn passed to the next seat. Counts, dummy
 * exposure and trick boundaries are deliberately left alone — those are the
 * server's to report, and guessing them is how an optimistic UI ends up
 * contradicting itself.
 *
 * Returns null whenever anything about the position is less than certain, in
 * which case Board.tsx waits for the response exactly as it always did. That
 * bar is on purpose: a wrong optimistic card is far worse than a slow honest
 * one, so every doubt resolves to "don't guess".
 */
export function optimisticPlayView(view: BoardView, card: number): BoardView | null {
  if (view.state !== 'playing' || !view.myTurn) return null;
  // the server's own legality verdict for this exact position — not a
  // re-derivation of the follow-suit rules, which web deliberately doesn't have
  if (!view.legalCards?.includes(card)) return null;
  const seat = view.handToPlay;
  if (seat === undefined) return null;

  const trick = view.currentTrick ?? [];
  // A full trick means the collect hasn't been staged yet, so the next card
  // does not belong to this trick — that is a boundary, and boundaries are
  // the server's call.
  if (trick.length >= 4) return null;
  if (trick.some((t) => t.card === card)) return null;

  // The human's OPENING LEAD is the one card whose staged step carries more
  // than the card itself: dummy is public only after it (game.ts's boardView
  // gates dummyHand on ps.dummyVisible), so the server's response is what
  // tables dummy. Predicting the lead alone would leave dummy to appear a
  // beat later with the robots' replies — a timing change to something other
  // than the tapped card, which this is deliberately not in the business of
  // making. One card per board keeps its old behavior instead.
  //
  // Stated directly rather than inferred from `dummyHand === undefined`
  // below. That check does catch the lead whenever the human is DEFENDING,
  // but game.ts's boardView also sends dummyHand when `dummy === HUMAN_SEAT`
  // — the flipped board, North declaring — where it is public from the first
  // card. That is safe today only because a flipped board's opening lead
  // belongs to East, so the human is never on lead to trick 1 in the one
  // case where dummyHand is already defined. Leaning on that would make this
  // function's correctness depend on a condition in another file that has no
  // reason to stay put, so the position is tested for what it actually is.
  if ((view.completedTricks ?? 0) === 0 && trick.length === 0) return null;

  // Needed on its own account too: the dummy fan is filtered below, so an
  // untabled dummy is nothing to predict against.
  const dummyHand = view.dummyHand;
  if (dummyHand === undefined) return null;

  // Which fan is it leaving? The human plays their own hand, and also dummy's
  // when declaring (game.ts's humanControls). Membership is checked rather
  // than assumed so a stale view can't produce a card in two places at once.
  const fromOwnFan = seat === (view.playingSeat ?? 2) && view.hand.includes(card);
  const fromDummyFan = !fromOwnFan && seat === view.dummy && dummyHand.includes(card);
  if (!fromOwnFan && !fromDummyFan) return null;

  return lockedView(view, {
    hand: fromOwnFan ? view.hand.filter((c) => c !== card) : view.hand,
    dummyHand: fromDummyFan ? dummyHand.filter((c) => c !== card) : dummyHand,
    currentTrick: [...trick, { seat, card }],
    handToPlay: (seat + 1) % 4,
  });
}

/**
 * Drop the leading staged step that an optimistic render has already put on
 * screen, and charge the time it has been up against the next step's delay.
 *
 * The steps themselves are still computed from the PRE-TAP view, so
 * stagePlaySteps produces byte-identically what it always did and none of its
 * (load-bearing, well-tested) reasoning about trick boundaries moves. All that
 * changes is which end of the list is still owed to the screen.
 *
 * Subtracting `elapsedMs` from the next step's delay is what keeps the pacing
 * honest: that delay (GLIDE_MS + ROBOT_GAP_MS between two cards, or
 * GLIDE_MS + HOLD_MS before a trick collects) is measured from the moment the
 * human's card landed, which is now earlier than the response. Without it the
 * robot's reply would arrive a full beat late on every trick.
 *
 * Every guard falls back to the untrimmed list, which is exactly today's
 * behavior — re-applying a view already on screen is a no-op (TrickArea's
 * glide is keyed on cards it hasn't seen), so the safe direction is to trim
 * nothing rather than to trim wrongly.
 */
export function trimStagedPrefix(steps: StagedStep[], shown: BoardView | null, elapsedMs: number): StagedStep[] {
  // Never trim to empty: the caller reads [] as "nothing to animate, jump
  // straight to the server view", which would discard the rest of the burst.
  if (!shown || steps.length < 2) return steps;
  const first = steps[0].view;
  if ((first.completedTricks ?? 0) !== (shown.completedTricks ?? 0)) return steps;
  if (!sameCards(first.currentTrick ?? [], shown.currentTrick ?? [])) return steps;

  const [, owed, ...rest] = steps;
  const spent = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return [{ ...owed, delayBefore: Math.max(0, owed.delayBefore - spent) }, ...rest];
}

/**
 * Stage the transition prev → next as timed snapshots. Returns [] whenever
 * there is nothing to animate (not a play-phase transition, no new cards, or
 * data that doesn't line up) — the caller then applies `next` directly.
 *
 * At most one trick boundary can occur per transition: the human plays at
 * least one card in every trick, so advanceRobots always stops within the
 * trick after the one the human just completed.
 */
export function stagePlaySteps(prev: BoardView, next: BoardView): StagedStep[] {
  const intoPlay = prev.state === 'bidding' && next.state === 'playing';
  const withinPlay = prev.state === 'playing' && (next.state === 'playing' || next.state === 'done');
  if (!intoPlay && !withinPlay) return [];
  if (prev.tournamentId !== next.tournamentId || prev.boardNo !== next.boardNo) return [];

  const prevTrick = withinPlay ? (prev.currentTrick ?? []) : [];
  const prevDone = withinPlay ? (prev.completedTricks ?? 0) : 0;
  const nextCur = next.currentTrick ?? [];
  const nextDone = next.completedTricks ?? 0;
  const boundary = nextDone === prevDone + 1;
  if (nextDone !== prevDone && !boundary) return []; // reload/race — don't guess

  // the plays that finish (or extend) the trick in progress, then the plays
  // that open the next trick
  const fullTrick = boundary ? (next.lastTrick ?? []) : nextCur;
  if (!sameCards(fullTrick.slice(0, prevTrick.length), prevTrick)) return [];
  const finishing = fullTrick.slice(prevTrick.length);
  const after = boundary ? nextCur : [];
  if (!finishing.length && !after.length) return [];

  const playingSeat = next.playingSeat ?? 2;
  const strain = (next.contract as { strain?: number } | undefined)?.strain;
  const winner = boundary
    ? strain !== undefined
      ? trickWinner(fullTrick, strain)
      : after.length
        ? after[0].seat
        : (next.handToPlay ?? fullTrick[0].seat)
    : 0;

  // Hands are reconstructed backward from `next`: a snapshot taken before a
  // play must still hold that card in its fan. Fans displaySort on render,
  // so append order doesn't matter.
  const staged = [...finishing, ...after];
  const handAt = (i: number) => {
    const pending = staged.slice(i);
    const mine = pending.filter((t) => t.seat === playingSeat).map((t) => t.card);
    return mine.length ? [...(next.hand ?? []), ...mine] : next.hand;
  };
  const dummyHandAt = (i: number) => {
    if (!next.dummyHand) return undefined;
    const pending = staged.slice(i);
    const dummys = pending.filter((t) => t.seat === next.dummy).map((t) => t.card);
    return dummys.length ? [...next.dummyHand, ...dummys] : next.dummyHand;
  };

  const steps: StagedStep[] = [];

  // entering play from the auction: settle the layout before the lead glides
  if (intoPlay) {
    steps.push({
      delayBefore: 0,
      view: lockedView(next, {
        currentTrick: [],
        completedTricks: 0,
        declarerTricks: 0,
        defenderTricks: 0,
        lastTrick: null,
        dummyHand: undefined, // dummy is tabled after the opening lead
        dummyHcp: undefined,
        handToPlay: finishing[0]?.seat,
        hand: handAt(0),
      }),
    });
  }

  finishing.forEach((play, i) => {
    steps.push({
      delayBefore: i === 0 ? (intoPlay ? 350 : 0) : GLIDE_MS + ROBOT_GAP_MS,
      view: lockedView(next, {
        currentTrick: [...prevTrick, ...finishing.slice(0, i + 1)],
        completedTricks: prevDone,
        declarerTricks: prev.declarerTricks ?? 0,
        defenderTricks: prev.defenderTricks ?? 0,
        lastTrick: withinPlay ? (prev.lastTrick ?? null) : null,
        handToPlay: (play.seat + 1) % 4,
        hand: handAt(i + 1),
        dummyHand: dummyHandAt(i + 1),
      }),
    });
  });

  if (boundary) {
    // the finished trick holds on the table, sweeps to the winner, then the
    // tally stamps — counts change only on the tally snapshot so TrickArea
    // can animate collect and stamp as separate beats
    steps.push({
      delayBefore: GLIDE_MS + HOLD_MS,
      view: lockedView(next, {
        currentTrick: [],
        completedTricks: nextDone,
        declarerTricks: prev.declarerTricks ?? 0,
        defenderTricks: prev.defenderTricks ?? 0,
        handToPlay: winner,
        hand: handAt(finishing.length),
        dummyHand: dummyHandAt(finishing.length),
      }),
    });
    steps.push({
      delayBefore: COLLECT_MS + 80,
      view: lockedView(next, {
        currentTrick: [],
        completedTricks: nextDone,
        handToPlay: winner,
        hand: handAt(finishing.length),
        dummyHand: dummyHandAt(finishing.length),
      }),
    });
    after.forEach((play, i) => {
      steps.push({
        delayBefore: i === 0 ? STAMP_MS : GLIDE_MS + ROBOT_GAP_MS,
        view: lockedView(next, {
          currentTrick: nextCur.slice(0, i + 1),
          completedTricks: nextDone,
          handToPlay: (play.seat + 1) % 4,
          hand: handAt(finishing.length + i + 1),
          dummyHand: dummyHandAt(finishing.length + i + 1),
        }),
      });
    });
  }

  // the real server view last: restores myTurn/legalCards (or shows the result)
  const lastWasPlay = !boundary || after.length > 0;
  steps.push({ delayBefore: lastWasPlay ? GLIDE_MS + 160 : STAMP_MS, view: next });
  return steps;
}

/**
 * Stage a whole BIDDING-phase transition: the human's own call, then the
 * robots' replies one at a time, then whatever the response actually left the
 * board in — a fresh turn for the human, a contract entering play, or a
 * passed-out board.
 *
 * advanceRobots runs until it's the human's turn again, so a single response
 * can carry three robot calls. Applied in one setBoard they all appear in the
 * same frame, "Robots are thinking…" renders for zero frames, and the auction
 * reads as though nobody else bid at all. Each snapshot here holds
 * `myTurn: false`, so the dock shows that notice for real while the calls
 * arrive.
 *
 * This owns the composition rather than leaving it to callers: a bidding
 * response can end the auction, and the fact that the reveal then has to hand
 * off to stagePlaySteps' opening-lead staging is exactly the kind of thing
 * that gets copied into one call site and forgotten in the other. A
 * transition with no new calls falls through to stagePlaySteps unchanged, so
 * a caller can dispatch on `prev.state === 'bidding'` alone.
 */
export function stageBidSteps(prev: BoardView, next: BoardView): StagedStep[] {
  if (prev.state !== 'bidding') return [];
  if (prev.tournamentId !== next.tournamentId || prev.boardNo !== next.boardNo) return [];
  const from = prev.auction.length;
  if (next.auction.length <= from) return stagePlaySteps(prev, next);
  // a reload or a race can hand us an auction that isn't an extension of the
  // one on screen — don't guess a reveal order for it
  if (!prev.auction.every((e, i) => e.call === next.auction[i]?.call && e.seat === next.auction[i]?.seat)) {
    return stagePlaySteps(prev, next);
  }

  const steps: StagedStep[] = [];
  for (let k = from + 1; k <= next.auction.length; k++) {
    // the human's own call lands the instant they commit — they made it, and
    // waiting a beat to see your own tap land reads as lag, not deliberation
    const own = steps.length === 0 && next.auction[k - 1].isHuman;
    steps.push({ delayBefore: own ? 0 : BID_GAP_MS, view: lockedBidView(prev, next.auction.slice(0, k)) });
  }

  // ...and then the real view. When the auction ended, stagePlaySteps has its
  // own staging to run (the layout settle, then the opening lead) — its first
  // step is a delayBefore: 0 that assumed it was starting from the response,
  // so it gets the turn-over beat instead.
  const tail = next.state === 'bidding' ? [] : stagePlaySteps(prev, next);
  const gap = next.state === 'bidding' ? BID_GAP_MS : AUCTION_END_MS;
  if (tail.length) steps.push({ ...tail[0], delayBefore: gap }, ...tail.slice(1));
  else steps.push({ delayBefore: gap, view: next });
  return steps;
}

// ---- claims ----

export interface ClaimAnnouncement {
  side: 'NS' | 'EW';
  tricks: number;
  /**
   * How many of the newly-completed tricks come BEFORE the guaranteed run —
   * the trick that was already in progress when the request went out, which
   * either side can still win. Excluded from `tricks`, and (see planClaim)
   * replayed at ordinary table pace BEFORE the announcement goes up: saying
   * "E/W CLAIM" over a trick the human is about to see themselves win reads
   * as the board contradicting itself. Always < the number of new tricks,
   * since the backward walk below always consumes the last one.
   */
  priorTricks: number;
}

/**
 * Which side is claiming, and how many tricks — derived entirely from data
 * already in the response, no dedicated server field needed. The claim is
 * only detected server-side at a decision point with more than one legal
 * card (forced single-card nodes skip the solve — see game.ts), so the
 * trick that was already in progress when the human's last request went out
 * can still be won by either side; only the tricks from the claim's true
 * detection point onward are guaranteed to the claiming side. That's always
 * a suffix of the newly-completed tricks (the burst runs to the end of the
 * board once claimed), so walk backward from the last trick — which is
 * always part of the true claim — to find where the pure run starts. That
 * boundary drives sequencing as well as the count: see `priorTricks`.
 */
export function claimAnnouncement(prev: BoardView, next: BoardView): ClaimAnnouncement | null {
  if (!next.claimed || !next.playHistory) return null;
  const strain = (next.contract as { strain?: number } | undefined)?.strain;
  if (strain === undefined) return null;
  const newTricks = next.playHistory.slice(prev.completedTricks ?? 0);
  if (!newTricks.length) return null;
  const lastParity = trickWinner(newTricks[newTricks.length - 1], strain) % 2;
  let tailStart = newTricks.length;
  while (tailStart > 0 && trickWinner(newTricks[tailStart - 1], strain) % 2 === lastParity) tailStart--;
  return { side: lastParity === 0 ? 'NS' : 'EW', tricks: newTricks.length - tailStart, priorTricks: tailStart };
}

/**
 * Stage a claim's tail as timed snapshots, spanning up to 13 tricks instead
 * of stagePlaySteps' single boundary. Kept separate from stagePlaySteps
 * rather than generalizing it: that function's single-trick-boundary
 * assumption is documented and load-bearing for ordinary play, and
 * stretching it here would risk destabilizing the common, well-tested path
 * — this instead loops the same per-card/per-trick shape stagePlaySteps
 * uses for one boundary.
 *
 * Unlike stagePlaySteps, this does NOT end with the real `next` view — every
 * step keeps `state: 'playing'` so the board only flips to 'done' (and the
 * receipt takes over) once the whole tail has played out. Board.tsx owns
 * that final hand-off, along with the announcement overlay it shows
 * beforehand, since those are plain timed UI state, not board-view
 * snapshots.
 *
 * `fast` (the settings tab's "Fast forward settled tricks", default false so
 * every call site opts in explicitly) picks which gap set every step uses:
 * false replays at the SAME per-card/per-trick pacing (GLIDE_MS/ROBOT_GAP_MS/
 * HOLD_MS/COLLECT_MS/STAMP_MS) stagePlaySteps uses for ordinary play — this
 * really is table speed, not merely "the claim pacing without the extra
 * speedup" (an earlier version conflated the two: CLAIM_GAP_MS/
 * CLAIM_TRICK_GAP_MS were themselves already a compressed pace, so turning
 * off just the CLAIM_SPEEDUP_FACTOR multiplier still played far faster than
 * a real trick ever does). true uses CLAIM_GAP_MS/CLAIM_TRICK_GAP_MS scaled
 * by CLAIM_SPEEDUP_FACTOR, both needed since a claim can span many tricks
 * and nobody wants to wait through 13 of them at table speed.
 *
 * `range` emits only the newly-completed tricks in [from, to) — which is how
 * planClaim splits one response into "the trick that was already in progress"
 * (table pace, before the announcement) and "the guaranteed run" (paced by
 * `fast`, after it). Only the PUSHES are gated: the accumulators, the winner
 * tally and — most importantly — `allPlays` still span the whole burst, so
 * every emitted view stays an absolute snapshot of the same board. Slicing
 * `newTricks` up front instead would make handAt() think the tail's cards
 * were already gone, and the human's remaining cards would vanish from their
 * fan during the lead and reappear when the fast-forward started.
 */
export function stageClaimSteps(
  prev: BoardView,
  next: BoardView,
  fast = false,
  range?: { from?: number; to?: number },
): StagedStep[] {
  if (prev.state !== 'playing' || next.state !== 'done' || !next.claimed || !next.playHistory) return [];
  if (prev.tournamentId !== next.tournamentId || prev.boardNo !== next.boardNo) return [];

  const strain = (next.contract as { strain?: number } | undefined)?.strain;
  const declarer = next.declarer;
  if (strain === undefined || declarer === undefined) return [];

  const prevDone = prev.completedTricks ?? 0;
  const prevTrick = prev.currentTrick ?? [];
  const newTricks = next.playHistory.slice(prevDone);
  if (!newTricks.length) return [];
  if (!sameCards(newTricks[0].slice(0, prevTrick.length), prevTrick)) return [];

  // The tally can't be assumed to belong wholly to one side: the claim is
  // only detected at a decision point with more than one legal card, so a
  // trick already in progress when this burst started may finish for
  // whichever side actually holds the winning card, before the guaranteed
  // run of claim tricks begins. Each trick's winner is tallied individually
  // (same rule as packages/core/src/play.ts) rather than assumed.
  const declParity = declarer % 2;

  const playingSeat = next.playingSeat ?? 2;
  const dummySeat = next.dummy;
  const allPlays = newTricks.flatMap((t, ti) => (ti === 0 ? t.slice(prevTrick.length) : t));

  // hands reconstructed backward, same as stagePlaySteps: a snapshot taken
  // before a play must still hold that card in its fan
  const handAt = (i: number) => {
    const pending = allPlays.slice(i);
    const mine = pending.filter((t) => t.seat === playingSeat).map((t) => t.card);
    return mine.length ? [...(next.hand ?? []), ...mine] : next.hand;
  };
  const dummyHandAt = (i: number) => {
    if (!next.dummyHand) return undefined;
    const pending = allPlays.slice(i);
    const dummys = pending.filter((t) => t.seat === dummySeat).map((t) => t.card);
    return dummys.length ? [...next.dummyHand, ...dummys] : next.dummyHand;
  };

  const lo = Math.max(0, Math.min(range?.from ?? 0, newTricks.length));
  const hi = Math.max(lo, Math.min(range?.to ?? newTricks.length, newTricks.length));

  const steps: StagedStep[] = [];
  let played = 0;
  let doneCount = prevDone;
  let declCount = prev.declarerTricks ?? 0;
  let defCount = prev.defenderTricks ?? 0;

  newTricks.forEach((trick, ti) => {
    const toPlay = ti === 0 ? trick.slice(prevTrick.length) : trick;
    // outside the range the tallies still advance (an emitted view has to
    // carry the running score), only the snapshots are withheld
    const emit = ti >= lo && ti < hi;
    toPlay.forEach((play, i) => {
      played += 1;
      if (!emit) return;
      // the first step of whatever range this is lands immediately: the
      // caller has already held for the announcement, or (for the lead) the
      // human just tapped the card
      const delayBefore =
        steps.length === 0
          ? 0
          : i === 0
            ? Math.round(fast ? CLAIM_TRICK_GAP_MS * CLAIM_SPEEDUP_FACTOR : STAMP_MS)
            : Math.round(fast ? CLAIM_GAP_MS * CLAIM_SPEEDUP_FACTOR : GLIDE_MS + ROBOT_GAP_MS);
      steps.push({
        delayBefore,
        view: lockedView(next, {
          currentTrick: [...(ti === 0 ? prevTrick : []), ...toPlay.slice(0, i + 1)],
          completedTricks: doneCount,
          declarerTricks: declCount,
          defenderTricks: defCount,
          lastTrick: ti === 0 ? (prev.lastTrick ?? null) : newTricks[ti - 1],
          handToPlay: (play.seat + 1) % 4,
          hand: handAt(played),
          dummyHand: dummyHandAt(played),
        }),
      });
    });
    const winner = trickWinner(trick, strain);
    doneCount += 1;
    if (winner % 2 === declParity) declCount += 1;
    else defCount += 1;
    const collected = lockedView(next, {
      currentTrick: [],
      completedTricks: doneCount,
      declarerTricks: declCount,
      defenderTricks: defCount,
      handToPlay: winner,
      hand: handAt(played),
      dummyHand: dummyHandAt(played),
    });
    if (!emit) return;
    if (fast) {
      // one beat: the compressed pace has no separate hold/collect split
      steps.push({ delayBefore: Math.round(CLAIM_GAP_MS * CLAIM_SPEEDUP_FACTOR), view: collected });
    } else {
      // table pace: the finished trick holds, then sweeps — the same two
      // beats stagePlaySteps uses for an ordinary trick boundary
      steps.push({ delayBefore: GLIDE_MS + HOLD_MS, view: collected });
      steps.push({ delayBefore: COLLECT_MS + 80, view: collected });
    }
  });

  return steps;
}

export interface ClaimPlan {
  info: ClaimAnnouncement;
  /**
   * The newly-completed tricks that are NOT part of the guaranteed run — the
   * trick that was already in progress when the request went out, which
   * either side can still win. Always at ordinary table pace: the
   * fast-forward setting paces the CLAIM, and this is not the claim. Empty
   * when the claim begins at the first new trick, which is the common case
   * (and byte-for-byte the behaviour that shipped before the split).
   */
  lead: StagedStep[];
  /** The guaranteed run, paced by `fast`. Empty when motion is off. */
  tail: StagedStep[];
}

/**
 * The whole arithmetic of a claim's three beats, in one pure place: the lead
 * (ordinary play, before the announcement), then the announcement, then the
 * guaranteed run. Board.tsx and Tour.tsx share this rather than each
 * re-deriving the split — their timer/React glue genuinely differs (different
 * scheduleSteps signatures, one awaited and one fire-and-forget), but the
 * question "which cards belong to which beat" must not drift between them.
 *
 * `lead` is computed regardless of `motion`: without WAAPI there's nothing to
 * animate, but its LAST view is still what the board must show before the
 * overlay covers it, so the caller applies that one directly.
 */
export function planClaim(
  prev: BoardView,
  next: BoardView,
  opts: { fast: boolean; motion: boolean },
): ClaimPlan | null {
  const info = claimAnnouncement(prev, next);
  if (!info) return null;
  return {
    info,
    lead: info.priorTricks > 0 ? stageClaimSteps(prev, next, false, { to: info.priorTricks }) : [],
    tail: opts.motion ? stageClaimSteps(prev, next, opts.fast, { from: info.priorTricks }) : [],
  };
}

/** How long a staged sequence takes end to end. */
export const totalDuration = (steps: StagedStep[]): number => steps.reduce((sum, step) => sum + step.delayBefore, 0);
