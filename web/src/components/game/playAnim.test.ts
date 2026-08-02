import { afterEach, describe, expect, it } from 'vitest';
import type { BoardView, TrickCard } from '../../api';
import { boardBidding, boardBiddingBurst, boardPlaying } from '../../test/fixtures';
import {
  AUCTION_END_MS,
  BID_GAP_MS,
  CLAIM_GAP_MS,
  CLAIM_SPEEDUP_FACTOR,
  CLAIM_TRICK_GAP_MS,
  COLLECT_MS,
  GLIDE_MS,
  HOLD_MS,
  ROBOT_GAP_MS,
  STAMP_MS,
  captureFanOriginIfVisible,
  capturePlayOrigin,
  claimAnnouncement,
  stageBidSteps,
  stageClaimSteps,
  stagePlaySteps,
  takePlayOrigin,
  trickWinner,
} from './playAnim';

// cards: suit*13 + rank, suit 0=♠ 1=♥ 2=♦ 3=♣, rank 0..12 = 2..A
const S = (r: number) => 0 * 13 + r;
const H = (r: number) => 1 * 13 + r;
const D = (r: number) => 2 * 13 + r;

describe('trickWinner (mirror of @bridge/core)', () => {
  it('highest card of the led suit wins in NT', () => {
    // ♠3 led, ♠A third hand; strain 4 = NT
    const trick = [
      { seat: 3, card: S(1) },
      { seat: 0, card: S(2) },
      { seat: 1, card: S(12) },
      { seat: 2, card: S(10) },
    ];
    expect(trickWinner(trick, 4)).toBe(1);
  });

  it('a trump beats the led suit; discards never win', () => {
    // hearts led; strain 1 = ♦ trump (suit 2); East ruffs with the ♦2
    const trick = [
      { seat: 0, card: H(12) },
      { seat: 1, card: D(0) },
      { seat: 2, card: H(11) },
      { seat: 3, card: S(12) },
    ];
    expect(trickWinner(trick, 1)).toBe(1);
  });

  it('the higher of two trumps wins', () => {
    const trick = [
      { seat: 0, card: H(5) },
      { seat: 1, card: D(0) },
      { seat: 2, card: D(7) },
      { seat: 3, card: H(9) },
    ];
    expect(trickWinner(trick, 1)).toBe(2);
  });
});

describe('play-origin capture', () => {
  it('is one-shot: capture, take, gone', () => {
    const rect = { left: 10, top: 20, width: 46, height: 66 } as DOMRect;
    capturePlayOrigin(12, rect);
    expect(takePlayOrigin(12)).toBe(rect);
    expect(takePlayOrigin(12)).toBeNull();
  });
});

describe('captureFanOriginIfVisible', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // jsdom's own getBoundingClientRect always returns all-zeros, so cards
  // added to the DOM here get a stubbed rect — same technique the app's own
  // flight code already relies on being non-zero to do anything.
  function addFanCard(card: number, width = 46): HTMLElement {
    const el = document.createElement('button');
    el.setAttribute('data-card', String(card));
    el.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width, height: 66, right: 10 + width, bottom: 86, x: 10, y: 20, toJSON() {} }) as DOMRect;
    document.body.appendChild(el);
    return el;
  }

  it('captures a still-visible bottom-fan (playingSeat) card', () => {
    addFanCard(5);
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 0 } as BoardView, { seat: 2, card: 5 });
    expect(takePlayOrigin(5)).not.toBeNull();
  });

  it('captures a still-visible top-fan dummy card, but not a side-rail (E/W) dummy card', () => {
    addFanCard(6);
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 0 } as BoardView, { seat: 0, card: 6 });
    expect(takePlayOrigin(6)).not.toBeNull();

    addFanCard(7);
    // East dummy renders as a DummyRail, not a HandFan — no fan to glide from
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 1 } as BoardView, { seat: 1, card: 7 });
    expect(takePlayOrigin(7)).toBeNull();
  });

  it('does not capture a robot seat with no fan on screen', () => {
    addFanCard(8);
    // seat 3 (West) is neither playingSeat nor dummy here
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 0 } as BoardView, { seat: 3, card: 8 });
    expect(takePlayOrigin(8)).toBeNull();
  });

  it('is a no-op once an origin is already captured — never overrides a real tap', () => {
    const tapped = { left: 1, top: 2, width: 3, height: 4 } as DOMRect;
    capturePlayOrigin(9, tapped);
    addFanCard(9, 999); // a very different rect, to prove it's not the one used
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 0 } as BoardView, { seat: 2, card: 9 });
    expect(takePlayOrigin(9)).toBe(tapped);
  });

  it('does nothing when the card has no element on screen at all', () => {
    captureFanOriginIfVisible({ playingSeat: 2, dummy: 0 } as BoardView, { seat: 2, card: 10 });
    expect(takePlayOrigin(10)).toBeNull();
  });
});

describe('stagePlaySteps', () => {
  // boardPlaying: 4♠ by S, trick 5 in progress [W♠3, N♠4, E♠2], S to play,
  // completedTricks 4, declarerTricks 3, defenderTricks 1
  const prev = boardPlaying;
  const myCard = prev.legalCards![1]; // ♠Q
  const fullTrick = [...prev.currentTrick!, { seat: 2, card: myCard }];

  it('returns [] for non-play transitions and echoed boards', () => {
    expect(stagePlaySteps(prev, prev)).toEqual([]); // no new cards
    const bidding = { ...prev, state: 'bidding' as const };
    expect(stagePlaySteps(bidding, bidding)).toEqual([]);
    // different board — never stage across boards
    expect(stagePlaySteps(prev, { ...prev, boardNo: prev.boardNo + 1 })).toEqual([]);
  });

  it('stages my card, hold, collect, tally, final when my play completes a trick', () => {
    const next: BoardView = {
      ...prev,
      contract: { level: 4, strain: 3, declarer: 2 },
      hand: prev.hand.filter((c) => c !== myCard),
      currentTrick: [],
      completedTricks: 5,
      declarerTricks: 4,
      defenderTricks: 1,
      lastTrick: fullTrick,
      myTurn: true,
      handToPlay: 2, // ♠Q wins (spades trump): I lead the next trick
      legalCards: [prev.legalCards![0]],
    };
    const steps = stagePlaySteps(prev, next);
    expect(steps).toHaveLength(4);

    // 1: my card lands in the trick, counts untouched, input locked
    expect(steps[0].delayBefore).toBe(0);
    expect(steps[0].view.currentTrick).toEqual(fullTrick);
    expect(steps[0].view.declarerTricks).toBe(3);
    expect(steps[0].view.myTurn).toBe(false);
    // the card leaves my fan immediately
    expect(steps[0].view.hand).not.toContain(myCard);

    // 2: after glide + hold, the trick clears (collect sweep) — counts still old
    expect(steps[1].delayBefore).toBe(GLIDE_MS + HOLD_MS);
    expect(steps[1].view.currentTrick).toEqual([]);
    expect(steps[1].view.completedTricks).toBe(5);
    expect(steps[1].view.declarerTricks).toBe(3);
    expect(steps[1].view.handToPlay).toBe(2); // winner awaits the next lead

    // 3: the tally stamps
    expect(steps[2].view.declarerTricks).toBe(4);

    // 4: the real server view restores my turn
    expect(steps[3].view).toBe(next);
    expect(steps[3].view.myTurn).toBe(true);
  });

  it('stages robot leads of the next trick after the collect', () => {
    const robotLead = { seat: 1, card: H(3) };
    const next: BoardView = {
      ...prev,
      contract: { level: 4, strain: 3, declarer: 2 },
      hand: prev.hand.filter((c) => c !== myCard),
      currentTrick: [robotLead],
      completedTricks: 5,
      declarerTricks: 3,
      defenderTricks: 2,
      lastTrick: [...prev.currentTrick!, { seat: 2, card: prev.legalCards![2] }], // my ♠10 — E's… defenders win
      myTurn: true,
      handToPlay: 2,
    };
    const steps = stagePlaySteps(prev, next);
    // my card, collect, tally, robot lead, final
    expect(steps).toHaveLength(5);
    expect(steps[3].view.currentTrick).toEqual([robotLead]);
    expect(steps[3].view.completedTricks).toBe(5);
    expect(steps[4].view).toBe(next);
  });

  it('stages robot cards one at a time when no trick completes', () => {
    // I lead a new trick; two robots follow before it is my partner's… my turn again
    const lead = { seat: 2, card: myCard };
    const r1 = { seat: 3, card: H(2) };
    const emptyPrev: BoardView = { ...prev, currentTrick: [], handToPlay: 2 };
    const next: BoardView = {
      ...prev,
      hand: prev.hand.filter((c) => c !== myCard),
      currentTrick: [lead, r1],
      myTurn: true,
      handToPlay: 0,
    };
    const steps = stagePlaySteps(emptyPrev, next);
    expect(steps).toHaveLength(3);
    expect(steps[0].view.currentTrick).toEqual([lead]);
    expect(steps[1].delayBefore).toBe(GLIDE_MS + ROBOT_GAP_MS);
    expect(steps[1].view.currentTrick).toEqual([lead, r1]);
    // the robot's card is not restored into any visible fan
    expect(steps[0].view.hand).toEqual(next.hand);
    expect(steps[2].view).toBe(next);
  });

  it('reconstructs fans backward: a dummy card stays in the dummy fan until its play is staged', () => {
    // human defends: E declares, N is dummy (visible), I lead the trick and
    // the robots — including dummy, played by the robot declarer — finish it
    const dummyCard = prev.dummyHand![0];
    const emptyPrev: BoardView = { ...prev, declarer: 1, dummy: 0, currentTrick: [], handToPlay: 2 };
    const fullNext: BoardView = {
      ...emptyPrev,
      contract: { level: 4, strain: 3, declarer: 1 },
      hand: prev.hand.filter((c) => c !== myCard),
      dummyHand: prev.dummyHand!.filter((c) => c !== dummyCard),
      currentTrick: [],
      completedTricks: 5,
      declarerTricks: 3,
      defenderTricks: 2,
      lastTrick: [
        { seat: 2, card: myCard },
        { seat: 3, card: S(6) }, // W ♠8
        { seat: 0, card: dummyCard },
        { seat: 1, card: S(3) }, // E ♠5
      ],
      myTurn: true,
      handToPlay: 2,
    };
    const steps = stagePlaySteps(emptyPrev, fullNext);
    // 4 plays + collect + tally + final
    expect(steps).toHaveLength(7);
    expect(prev.dummyHand).toContain(dummyCard);
    // before dummy's play is staged, the card is still in the dummy fan…
    expect(steps[1].view.dummyHand).toContain(dummyCard);
    // …and it leaves exactly when the play lands on the table
    expect(steps[2].view.currentTrick!.at(-1)).toEqual({ seat: 0, card: dummyCard });
    expect(steps[2].view.dummyHand).not.toContain(dummyCard);
  });

  it('stages the opening lead when the auction just ended, hiding dummy first', () => {
    const lead = { seat: 3, card: H(9) };
    const biddingPrev: BoardView = { ...prev, state: 'bidding', currentTrick: undefined, completedTricks: undefined };
    const next: BoardView = {
      ...prev,
      currentTrick: [lead],
      completedTricks: 0,
      declarerTricks: 0,
      defenderTricks: 0,
      lastTrick: null,
      myTurn: true,
      handToPlay: 0,
    };
    const steps = stagePlaySteps(biddingPrev, next);
    // base layout (no trick, dummy face down), the lead, then the real view
    expect(steps).toHaveLength(3);
    expect(steps[0].view.currentTrick).toEqual([]);
    expect(steps[0].view.dummyHand).toBeUndefined();
    expect(steps[1].view.currentTrick).toEqual([lead]);
    expect(steps[1].view.dummyHand).toEqual(next.dummyHand);
    expect(steps[2].view).toBe(next);
  });

  it('bails to a direct jump when the server data does not line up', () => {
    // trick cleared but lastTrick does not extend what we were showing
    const next: BoardView = {
      ...prev,
      currentTrick: [],
      completedTricks: 5,
      lastTrick: [
        { seat: 3, card: H(2) },
        { seat: 0, card: H(3) },
        { seat: 1, card: H(4) },
        { seat: 2, card: H(5) },
      ],
    };
    expect(stagePlaySteps(prev, next)).toEqual([]);
    // two boundaries at once (stale tab): never animate a guess
    expect(stagePlaySteps(prev, { ...prev, completedTricks: 7, currentTrick: [] })).toEqual([]);
  });
});

// ---- bidding ----

describe('stageBidSteps', () => {
  const prev = boardBidding; // 6 calls on the tray, South to call
  const next = boardBiddingBurst; // + South's 2♥ and the robots' three replies
  const mkEntry = (seat: number, call: number, name: string) => ({ seat, call, name, isHuman: seat === 2, meaning: null });

  it('returns [] outside the bidding phase and across boards', () => {
    expect(stageBidSteps(boardPlaying, boardPlaying)).toEqual([]);
    expect(stageBidSteps(prev, { ...next, boardNo: prev.boardNo + 1 })).toEqual([]);
    expect(stageBidSteps(prev, { ...next, tournamentId: prev.tournamentId + 1 })).toEqual([]);
  });

  it('falls through to stagePlaySteps when there are no new calls to reveal', () => {
    // an echoed board — stagePlaySteps says [] for bidding→bidding too
    expect(stageBidSteps(prev, prev)).toEqual([]);
    // ...and an auction that isn't an extension of the one on screen (a
    // reload, a race) is never guessed at
    const divergent = { ...next, auction: [...next.auction.slice(1), next.auction[0]] };
    expect(stageBidSteps(prev, divergent)).toEqual([]);
  });

  it('reveals one call at a time, the human’s own immediately and the robots on a beat', () => {
    const steps = stageBidSteps(prev, next);
    expect(steps).toHaveLength(4 + 1); // four new calls, then the real view

    // the human's own call is already theirs — waiting to see your own tap
    // land reads as lag, not deliberation
    expect(steps[0].delayBefore).toBe(0);
    expect(steps[1].delayBefore).toBe(BID_GAP_MS);
    expect(steps[2].delayBefore).toBe(BID_GAP_MS);
    expect(steps[3].delayBefore).toBe(BID_GAP_MS);
    expect(steps[4].delayBefore).toBe(BID_GAP_MS);

    // each snapshot is the auction one call longer than the last
    expect(steps.slice(0, 4).map((s) => s.view.auction.length)).toEqual([7, 8, 9, 10]);
    for (const [i, step] of steps.slice(0, 4).entries()) {
      expect(step.view.auction).toEqual(next.auction.slice(0, 7 + i));
    }

    // locked while the robots reply: this is what makes the thinking notice
    // render for real instead of for zero frames
    for (const step of steps.slice(0, 4)) {
      expect(step.view.state).toBe('bidding');
      expect(step.view.myTurn).toBe(false);
      // ...but the legal calls SURVIVE, unlike a locked play-phase view. They
      // size the docked bid box, which stays on screen inert so the hand and
      // feedback above it don't slide down the screen and back every turn.
      expect(step.view.legalCalls).toBe(prev.legalCalls);
      // ...and everything else is still PREV's board — see lockedBidView
      expect(step.view.hand).toBe(prev.hand);
      expect(step.view.hcp).toBe(prev.hcp);
    }

    // the response itself lands last, by identity — Tour.tsx's caption gate
    // compares the staged view against its own step's view by reference
    expect(steps[4].view).toBe(next);
  });

  it('hands the auction’s last call off to the opening-lead staging, on a longer beat', () => {
    // South passes out partner's contract: the auction ends and West leads
    const intoPlay: BoardView = {
      ...boardPlaying,
      auction: [...prev.auction, mkEntry(2, 0, 'Pass')],
      currentTrick: [{ seat: 3, card: S(1) }],
      completedTricks: 0,
      declarerTricks: 0,
      defenderTricks: 0,
      lastTrick: null,
    };
    const steps = stageBidSteps(prev, intoPlay);
    const play = stagePlaySteps(prev, intoPlay);
    expect(play.length).toBeGreaterThan(0);
    expect(steps).toHaveLength(1 + play.length);
    expect(steps[0].view.state).toBe('bidding');
    expect(steps[0].view.auction.length).toBe(prev.auction.length + 1);
    // the table turning over is a bigger event than one more call
    expect(steps[1].delayBefore).toBe(AUCTION_END_MS);
    expect(steps.slice(1).map((s) => s.view)).toEqual(play.map((s) => s.view));
    expect(steps[steps.length - 1].view).toBe(intoPlay);
  });

  it('still reveals the calls when the board ends without entering play', () => {
    // passed out: no contract, so stagePlaySteps has nothing to stage
    const passedOut: BoardView = {
      ...prev,
      state: 'done',
      myTurn: false,
      legalCalls: undefined,
      auction: [...prev.auction, mkEntry(2, 0, 'Pass'), mkEntry(3, 0, 'Pass')],
    };
    const steps = stageBidSteps(prev, passedOut);
    expect(steps).toHaveLength(2 + 1);
    expect(steps[2].view).toBe(passedOut);
    expect(steps[2].delayBefore).toBe(AUCTION_END_MS);
  });

  it('keeps a full burst under two seconds — a reveal, not a stall', () => {
    const total = stageBidSteps(prev, next).reduce((sum, s) => sum + s.delayBefore, 0);
    expect(total).toBeLessThan(2000);
  });
});

// ---- claims ----
// A near-the-end position: 11 tricks already complete (8-3 for declarer),
// 2 spades left in each of South's and dummy's hands. N-S (South declares)
// claims both remaining tricks.
const claimContract = { level: 4, strain: 3, declarer: 2 }; // spades trump
const placeholderTrick: TrickCard[] = [
  { seat: 0, card: D(0) },
  { seat: 1, card: D(1) },
  { seat: 2, card: D(5) },
  { seat: 3, card: D(6) },
];
const claimPrev: BoardView = {
  ...boardPlaying,
  contract: claimContract,
  completedTricks: 11,
  currentTrick: [],
  declarerTricks: 8,
  defenderTricks: 3,
  hand: [S(9), S(10)],
  dummyHand: [S(7), S(8)],
};
const trick12: TrickCard[] = [
  { seat: 2, card: S(9) },
  { seat: 3, card: S(0) },
  { seat: 0, card: S(1) },
  { seat: 1, card: S(2) },
];
const trick13: TrickCard[] = [
  { seat: 2, card: S(10) },
  { seat: 3, card: S(3) },
  { seat: 0, card: S(4) },
  { seat: 1, card: S(6) },
];
const claimNext: BoardView = {
  ...claimPrev,
  state: 'done',
  claimed: true,
  myTurn: false,
  legalCards: undefined,
  hand: [],
  dummyHand: [],
  completedTricks: 13,
  declarerTricks: 10,
  defenderTricks: 3,
  currentTrick: [],
  playHistory: [...Array(11).fill(placeholderTrick), trick12, trick13],
};

describe('claimAnnouncement', () => {
  it('derives the claiming side and trick count from playHistory alone', () => {
    // South (seat 2, the N-S side) wins both new tricks
    expect(claimAnnouncement(claimPrev, claimNext)).toEqual({ side: 'NS', tricks: 2 });
  });

  it('returns null without the claimed flag, playHistory, or a resolvable strain', () => {
    const withHistory = { ...claimPrev, state: 'done' as const, playHistory: claimNext.playHistory };
    expect(claimAnnouncement(claimPrev, withHistory)).toBeNull(); // no claimed flag
    expect(claimAnnouncement(claimPrev, { ...claimNext, playHistory: undefined })).toBeNull();
    expect(claimAnnouncement(claimPrev, { ...claimNext, contract: undefined })).toBeNull();
  });
});

describe('stageClaimSteps', () => {
  it('returns [] when the transition is not a claim', () => {
    expect(stageClaimSteps(claimPrev, { ...claimNext, claimed: false })).toEqual([]);
    expect(stageClaimSteps({ ...claimPrev, state: 'bidding' }, claimNext)).toEqual([]);
    expect(stageClaimSteps(claimPrev, { ...claimNext, playHistory: undefined })).toEqual([]);
  });

  it('at table pace (the default), stages every new trick with the SAME beats stagePlaySteps uses', () => {
    const steps = stageClaimSteps(claimPrev, claimNext);
    // per trick: 4 cards, then a hold beat and a collect beat (mirrors
    // stagePlaySteps' boundary block) — 6 beats × 2 tricks
    expect(steps).toHaveLength(12);

    // every intermediate view stays locked in "playing" — Board.tsx owns the
    // hand-off to 'done' after the terminal stamp, not this function
    for (const step of steps) {
      expect(step.view.state).toBe('playing');
      expect(step.view.myTurn).toBe(false);
      expect(step.view.legalCards).toBeUndefined();
    }
    expect(steps.some((s) => s.view.state === 'done')).toBe(false);

    // first card lands immediately (the caller already held for the announce beat)
    expect(steps[0].delayBefore).toBe(0);
    expect(steps[0].view.currentTrick).toEqual([trick12[0]]);
    expect(steps[0].view.hand).not.toContain(S(9));
    // a card within the same trick uses the ordinary robot-to-robot gap
    expect(steps[1].delayBefore).toBe(GLIDE_MS + ROBOT_GAP_MS);

    // trick 12 holds, then sweeps: the claiming side's tally (declarer here)
    // bumps on both beats (they share one view, same as stagePlaySteps)
    expect(steps[4].delayBefore).toBe(GLIDE_MS + HOLD_MS);
    expect(steps[5].delayBefore).toBe(COLLECT_MS + 80);
    for (const i of [4, 5]) {
      expect(steps[i].view.currentTrick).toEqual([]);
      expect(steps[i].view.completedTricks).toBe(12);
      expect(steps[i].view.declarerTricks).toBe(9);
      expect(steps[i].view.defenderTricks).toBe(3);
    }

    // the second trick's opening card uses the ordinary post-collect gap
    expect(steps[6].delayBefore).toBe(STAMP_MS);
    expect(steps[6].view.currentTrick).toEqual([trick13[0]]);

    // final staged step: fully tallied, hands empty
    const last = steps[11];
    expect(last.view.completedTricks).toBe(13);
    expect(last.view.declarerTricks).toBe(10);
    expect(last.view.hand).toEqual([]);
    expect(last.view.dummyHand).toEqual([]);
  });

  it('reconciles a trick already in progress before staging the rest', () => {
    const midTrickPrev: BoardView = { ...claimPrev, currentTrick: [trick12[0], trick12[1]] };
    const steps = stageClaimSteps(midTrickPrev, claimNext);
    // 2 remaining cards of trick 12 + hold + collect, then all of trick 13 + hold + collect
    expect(steps).toHaveLength(2 + 2 + 4 + 2);
    expect(steps[0].view.currentTrick).toEqual([trick12[0], trick12[1], trick12[2]]);
  });

  it('bails to [] when the in-progress trick does not match playHistory', () => {
    const mismatched: BoardView = { ...claimPrev, currentTrick: [{ seat: 2, card: H(0) }] };
    expect(stageClaimSteps(mismatched, claimNext)).toEqual([]);
  });

  // fast=true is the settings tab's "Fast forward settled tricks" ON: the
  // compressed claim pacing (CLAIM_GAP_MS/CLAIM_TRICK_GAP_MS), scaled further
  // by CLAIM_SPEEDUP_FACTOR, with one beat per trick instead of two.
  it('fast=true uses the compressed, sped-up claim pacing instead of table speed', () => {
    const steps = stageClaimSteps(claimPrev, claimNext, true);
    // 4 cards + 1 collect beat per trick (no separate hold/collect split)
    expect(steps).toHaveLength(10);
    expect(steps[0].delayBefore).toBe(0); // 0 * factor is still 0
    expect(steps[4].delayBefore).toBe(Math.round(CLAIM_GAP_MS * CLAIM_SPEEDUP_FACTOR));
    expect(steps[5].delayBefore).toBe(Math.round(CLAIM_TRICK_GAP_MS * CLAIM_SPEEDUP_FACTOR));

    // this is meaningfully faster than any table-pace gap
    const tablePace = stageClaimSteps(claimPrev, claimNext);
    expect(steps[5].delayBefore).toBeLessThan(tablePace[6].delayBefore);
  });
});

// ---- mixed leading trick ----
// The claim is only detected server-side at a decision point with more than
// one legal card (a forced single-legal-card node skips the DD solve — see
// game.ts), so the trick already in progress when the client's last request
// went out can finish for either side before the guaranteed claim run
// begins. Here West (defense) already holds the ace of trumps in the
// in-progress trick — defense wins it regardless of the claim — and only
// the two tricks after that are the true (declarer) laydown.
const C = (r: number) => 3 * 13 + r;
const mixedContract = { level: 4, strain: 3, declarer: 2 }; // spades trump, South declares
const mixedPrev: BoardView = {
  ...boardPlaying,
  contract: mixedContract,
  completedTricks: 9,
  currentTrick: [
    { seat: 3, card: S(12) }, // West leads the ace of spades
    { seat: 0, card: S(1) },
  ],
  declarerTricks: 6,
  defenderTricks: 3,
};
const mixedTrick: TrickCard[] = [
  ...mixedPrev.currentTrick!,
  { seat: 2, card: S(2) }, // South (declarer) forced to follow low
  { seat: 1, card: S(3) },
]; // West's ace wins — defense takes this trick despite the coming claim
const declTrick1: TrickCard[] = [
  { seat: 0, card: C(12) }, // North (N-S) wins on the ace of clubs
  { seat: 1, card: C(1) },
  { seat: 2, card: C(2) },
  { seat: 3, card: C(3) },
];
const declTrick2: TrickCard[] = [
  { seat: 0, card: C(11) },
  { seat: 1, card: C(4) },
  { seat: 2, card: C(5) },
  { seat: 3, card: C(6) },
];
const mixedNext: BoardView = {
  ...mixedPrev,
  state: 'done',
  claimed: true,
  myTurn: false,
  legalCards: undefined,
  hand: [],
  dummyHand: [],
  completedTricks: 12,
  declarerTricks: 8,
  defenderTricks: 4,
  currentTrick: [],
  playHistory: [...Array(9).fill(placeholderTrick), mixedTrick, declTrick1, declTrick2],
};

describe('claimAnnouncement — mixed leading trick', () => {
  it('does not count the in-progress trick toward the claim when it goes to the other side', () => {
    // if it blindly trusted the first new trick, this would wrongly report
    // {side: 'EW', tricks: 3} — West's ace, not the actual N-S laydown
    expect(claimAnnouncement(mixedPrev, mixedNext)).toEqual({ side: 'NS', tricks: 2 });
  });
});

describe('stageClaimSteps — mixed leading trick', () => {
  it('tallies the in-progress trick to whichever side actually won it, not the claiming side', () => {
    const steps = stageClaimSteps(mixedPrev, mixedNext);
    // 2 cards to finish trick 9 + hold + collect, then (4 cards + hold + collect) × 2
    expect(steps).toHaveLength(2 + 2 + 6 + 6);

    // the mixed trick's collect bumps the DEFENSE tally, not declarer
    const mixedCollect = steps[3];
    expect(mixedCollect.view.completedTricks).toBe(10);
    expect(mixedCollect.view.declarerTricks).toBe(6);
    expect(mixedCollect.view.defenderTricks).toBe(4);

    // the two clean claim tricks after it bump declarer's tally only
    const last = steps[steps.length - 1];
    expect(last.view.completedTricks).toBe(12);
    expect(last.view.declarerTricks).toBe(8);
    expect(last.view.defenderTricks).toBe(4);
  });
});
