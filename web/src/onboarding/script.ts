import type { TourBoard } from './board0';

/**
 * The tollkeeper's script — the hand-curated narration overlay for the
 * captured practice board (board0.json, seed "crossing-43"). Curated the
 * same way demo scenario copy is: the capture is machine-generated, the
 * words are written against it by hand, and script.test.ts pins the two
 * together (expected actions, guided/auto split) so a regenerated capture
 * fails loudly here instead of narrating the wrong deal.
 *
 * Voice rules (.claude/skills/nickel-bridge-design): warm, second person,
 * period-inflected; suit glyphs render through SuitText; no emoji.
 *
 * The line being narrated (all of it the model's own choice — every grade
 * toast honestly reads "the robot's choice too"):
 *   S 1NT · W pass · N 2♥ (Jacoby transfer — artificial) · E pass ·
 *   S 2♠ · W pass · N 3NT (choice of games) · E pass · S 4♠ · all pass.
 *   W leads the ♥3; dummy's singleton ♥10 holds trick 1; trick 2 starts
 *   trumps from the table; the tail self-plays to 4♠ made exactly, +420.
 */

export interface StepGuidance {
  /** the ribbon line while this decision waits */
  say: string;
  /** swap-in after a legal-but-off-script commit attempt */
  offScript?: string;
  /** self-play this decision (the fast-forward tail) */
  auto?: boolean;
  /** guard-test pin: the capture's action at this index must equal this */
  expect?: number;
}

export const COPY = {
  gateLine: (handle: string) => `“Evening, ${handle}. First time across this bridge?”`,
  gateAside: 'Either way, you’ll be at a table in under three minutes.',

  offerTitle: 'A practice crossing.',
  offerBody:
    'Before your first real crossing, walk one deal with the tollkeeper. You’ll bid a hand, play a card or two, and learn to read the ledger.',
  offerAside: 'Not scored. Not rated. Never spoken of.',
  offerSkip: 'STRAIGHT TO THE BRIDGE — I’VE PLAYED BEFORE',

  offScriptCall: 'A fine thought — and its meaning is right there. But tonight, follow the tollkeeper.',
  offScriptCard: 'A fair card — but take the marked one tonight. The meanings of your own experiments come later.',
  fastForward:
    'That’s the whole idea — the rest of tonight’s tricks play themselves. Watch the meter; the house knows when to spend an honor and when to keep one.',

  receiptSay:
    'Scored and itemized — every crossing prints a receipt like this. Read where the toll came from, then see who else was on the bridge.',
  fieldSay:
    'You didn’t cross alone: the house played this very deal before you — same cards, same robots. The Shark landed your exact line, so you split the matchpoints. The Novice held your cards too, and went two down. That’s duplicate: the deal is never the difference.',

  doneTitle: 'That’s the whole game.',
  doneBody:
    'Bid with meaning. Play with care. Read the ledger. From here it counts: four deals a crossing, your friends on the same cards, one ledger between you.',
  doneAside: 'The tollkeeper keeps no record of practice boards.',
} as const;

/**
 * Guidance per captured decision index. Steps 0–2 are the auction, 3–18 the
 * play; anything past this array (or marked auto) self-plays. Card/call
 * numbers in `expect` use the shared encodings in web/src/api.ts.
 */
export const STEPS: StepGuidance[] = [
  {
    // 1NT (call 7)
    say: 'Your hand, counted: fifteen points, evenly spread. That’s the most honest bid in the game — tap 1NT and read what it promises. Nothing is final until you confirm.',
    offScript: 'Each of these has its meaning — that’s the point of the box. Tonight, though: 1NT, the honest one.',
    expect: 7,
  },
  {
    // 2♠ (call 11), after partner's Jacoby transfer
    say: 'Marked and filed — every call you make gets graded like that. Now: partner’s 2♥ is a code word, not a heart in sight. Tap it in the auction and read it. It orders you to say 2♠ — obey.',
    offScript: 'Partner gave an order in code. 2♠ — the transfer must be obeyed.',
    expect: 11,
  },
  {
    // 4♠ (call 21), over partner's choice-of-games 3NT
    say: 'Partner shows five spades and offers a choice of games. You hold three spades — eight trumps between you. Take the suit game: 4♠.',
    offScript: 'Playable, perhaps — but with eight trumps between you, the spade game rates best. 4♠.',
    expect: 21,
  },
  {
    // dummy's forced ♥10 (card 21) — auto-plays; the ribbon explains dummy
    say: 'West leads, and partner lays their hand on the table. That’s dummy — yours to play tonight. One heart up there, so it plays itself.',
    expect: 21,
  },
  {
    // S follows with the ♥4 (card 15) — the two-step tap
    say: 'Dummy’s ten is already winning the trick — East couldn’t beat it. Spend nothing: tap your ♥4 to select it, then tap again to play. Deliberate, always.',
    offScript: 'It would win, but the ten already has the trick. The ♥4 keeps your honors for later.',
    expect: 15,
  },
  {
    // dummy leads the ♠2 (card 0) — trumps begin
    say: 'The table won it, so the table leads. Time to pull their trumps — start low: the ♠2 from dummy.',
    offScript: 'Trumps first is right — begin with dummy’s ♠2 and keep the high ones flexible.',
    expect: 0,
  },
];

/** Guidance for any decision index — the tail self-plays. */
export function guidanceFor(idx: number, data: TourBoard): StepGuidance {
  const g = STEPS[idx];
  if (g && idx < data.steps.length) return g;
  return { say: COPY.fastForward, auto: true };
}
