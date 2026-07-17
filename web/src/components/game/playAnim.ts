import type { BoardView, TrickCard } from '../../api';
import { cardRank, cardSuit } from '../../api';

/**
 * Card-play animation support: turns one server board transition into a
 * timed sequence of intermediate views, so the table plays out one card at a
 * time instead of jumping straight to the final state.
 *
 * The server resolves a whole burst of robot actions per request
 * (advanceRobots runs until it's the human's turn again), so the response can
 * contain: the human's card, the robot cards that finished the trick, a trick
 * boundary, and the robot leads of the next trick. stagePlaySteps
 * reconstructs that burst as snapshots; Board.tsx applies them on timers, and
 * TrickArea animates each diff (glide-in, collect sweep, tally stamp) as the
 * snapshots land. Everything here is pure and unit-tested; the DOM work
 * lives in TrickArea.
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
export const AUTO_PLAY_DELAY_MS = 150;

// A claim's fast-forward pacing: much shorter than ROBOT_GAP_MS/HOLD_MS+
// STAMP_MS since a claim can span many tricks — the glide/collect beats
// themselves (GLIDE_MS/COLLECT_MS) are untouched, only the gaps between
// them compress. The announcement banner (Board.tsx) pops up right as the
// fast-forward starts and stays in place for the whole burst — no separate
// hold beat or terminal stamp needed.
export const CLAIM_GAP_MS = 130;
export const CLAIM_TRICK_GAP_MS = 110;

// Without motion (reduced-motion, or no WAAPI) there's no fast-forward to
// hold the banner up for, so Board.tsx displays it for at least this long
// before jumping straight to the result — same "always applies" reasoning
// as AUTO_PLAY_DELAY_MS.
export const CLAIM_MIN_DISPLAY_MS = 1200;

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

// ---- claims ----

export interface ClaimAnnouncement {
  side: 'NS' | 'EW';
  tricks: number;
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
 * always part of the true claim — to find where the pure run starts.
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
  return { side: lastParity === 0 ? 'NS' : 'EW', tricks: newTricks.length - tailStart };
}

/**
 * Stage a claim's fast-forward as timed snapshots, mirroring stagePlaySteps'
 * glide/collect beats but compressed and spanning up to 13 tricks instead of
 * at most one boundary. Kept separate from stagePlaySteps rather than
 * generalizing it: that function's single-trick-boundary assumption is
 * documented and load-bearing for ordinary play, and stretching it here
 * would risk destabilizing the common, well-tested path.
 *
 * Unlike stagePlaySteps, this does NOT end with the real `next` view — every
 * step keeps `state: 'playing'` so the board only flips to 'done' (and the
 * receipt takes over) once the whole fast-forward has played out. Board.tsx
 * owns that final hand-off, along with the announcement banner it keeps
 * visible for the duration, since those are plain timed UI state, not
 * board-view snapshots.
 */
export function stageClaimSteps(prev: BoardView, next: BoardView): StagedStep[] {
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

  const steps: StagedStep[] = [];
  let played = 0;
  let doneCount = prevDone;
  let declCount = prev.declarerTricks ?? 0;
  let defCount = prev.defenderTricks ?? 0;

  newTricks.forEach((trick, ti) => {
    const toPlay = ti === 0 ? trick.slice(prevTrick.length) : trick;
    toPlay.forEach((play, i) => {
      played += 1;
      const delayBefore = ti === 0 && i === 0 ? 0 : i === 0 ? CLAIM_TRICK_GAP_MS : CLAIM_GAP_MS;
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
    steps.push({
      delayBefore: CLAIM_GAP_MS,
      view: lockedView(next, {
        currentTrick: [],
        completedTricks: doneCount,
        declarerTricks: declCount,
        defenderTricks: defCount,
        handToPlay: winner,
        hand: handAt(played),
        dummyHand: dummyHandAt(played),
      }),
    });
  });

  return steps;
}
