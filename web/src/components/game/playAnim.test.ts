import { describe, expect, it } from 'vitest';
import type { BoardView, TrickCard } from '../../api';
import { boardPlaying } from '../../test/fixtures';
import {
  CLAIM_TRICK_GAP_MS,
  GLIDE_MS,
  HOLD_MS,
  ROBOT_GAP_MS,
  capturePlayOrigin,
  claimAnnouncement,
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

  it('stages every new trick card-by-card, ending fully tallied but NOT at the real done view', () => {
    const steps = stageClaimSteps(claimPrev, claimNext);
    // 4 cards + collect for trick 12, 4 cards + collect for trick 13
    expect(steps).toHaveLength(10);

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

    // trick 12 collects: the claiming side's tally (declarer here) bumps
    expect(steps[4].view.currentTrick).toEqual([]);
    expect(steps[4].view.completedTricks).toBe(12);
    expect(steps[4].view.declarerTricks).toBe(9);
    expect(steps[4].view.defenderTricks).toBe(3);

    // the second trick's opening card uses the (longer) inter-trick gap
    expect(steps[5].delayBefore).toBe(CLAIM_TRICK_GAP_MS);
    expect(steps[5].view.currentTrick).toEqual([trick13[0]]);

    // final staged step: fully tallied, hands empty
    const last = steps[9];
    expect(last.view.completedTricks).toBe(13);
    expect(last.view.declarerTricks).toBe(10);
    expect(last.view.hand).toEqual([]);
    expect(last.view.dummyHand).toEqual([]);
  });

  it('reconciles a trick already in progress before staging the rest', () => {
    const midTrickPrev: BoardView = { ...claimPrev, currentTrick: [trick12[0], trick12[1]] };
    const steps = stageClaimSteps(midTrickPrev, claimNext);
    // 2 remaining cards of trick 12 + collect, then all of trick 13 + collect
    expect(steps).toHaveLength(8);
    expect(steps[0].view.currentTrick).toEqual([trick12[0], trick12[1], trick12[2]]);
  });

  it('bails to [] when the in-progress trick does not match playHistory', () => {
    const mismatched: BoardView = { ...claimPrev, currentTrick: [{ seat: 2, card: H(0) }] };
    expect(stageClaimSteps(mismatched, claimNext)).toEqual([]);
  });
});
