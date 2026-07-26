import type { LinkPolicy } from '../glossary/linkify';
import type { TourBoard } from './board0';

/**
 * The tollkeeper's script — the hand-curated narration overlay for the
 * captured practice board (board0.json, seed "crossing-43"). Curated the
 * same way demo scenario copy is: the capture is machine-generated, the
 * words are written against it by hand, and tour.test.tsx pins the two
 * together (expected actions, and the field outcomes fieldSay names) so a
 * regenerated capture fails loudly here instead of narrating the wrong deal.
 *
 * Voice rules (.claude/skills/nickel-bridge-design): warm, second person,
 * period-inflected; suit glyphs render through SuitText; no emoji.
 *
 * And one rule this screen has that the rest of the app doesn't: **no
 * time-of-day words**. The club's evening-lamplight register is tempting —
 * the copy was written in it, and the whole tour read "tonight" — but a
 * first crossing is walked at whatever hour the account is made, and the
 * ledger has no idea which. "On this crossing", "this time", "this once"
 * carry the same sense of a one-off, guided occasion and stay true at nine
 * in the morning. (Home's "Good morning/afternoon/evening" is the one place
 * that may name the hour: it actually checks the clock.)
 *
 * The line being narrated (all of it the model's own choice — every grade
 * toast honestly reads "the robot's choice too"):
 *   S 1NT · W pass · N 2♥ (Jacoby transfer — artificial) · E pass ·
 *   S 2♠ · W pass · N 3NT (choice of game) · E pass · S 4♠ · all pass.
 *   W leads the ♥3; dummy's singleton ♥10 holds trick 1; trick 2 starts
 *   trumps from the table; the tail self-plays to 4♠ made exactly, +420.
 */

/**
 * How the tour links to the glossary. Every line below renders through
 * GlossaryProse (pages/Tour.tsx's TourProse), so the copy stays plain strings
 * and the matcher decides — but the tour is a teaching surface, not gameplay
 * prose, and it needs a different dial than the sitewide one:
 *
 * - `force` re-links the handful of words terms.ts marks `linkify: false`
 *   because they'd be a link farm in bid copy. In this pamphlet each appears
 *   about once, to someone who has never seen it before — "eight trumps
 *   between you" and "a choice of game" are precisely the sentences a first
 *   crossing should be able to look up.
 * - `skip` drops a match that reads in the wrong sense here: "you split the
 *   matchpoints" is a tie, not a suit Break (terms.ts aliases "split").
 *
 * Everything else the tour teaches — dummy, HCP, the auction, the Jacoby
 * transfer, duplicate, matchpoints, honors — the sitewide matcher already
 * links on its own.
 */
export const TOUR_LINKS: LinkPolicy = {
  force: ['deal', 'game', 'lead', 'trick', 'trump'],
  skip: ['break'],
};

export interface StepGuidance {
  /** the ribbon line while this decision waits */
  say: string;
  /** swap-in after a legal-but-off-script commit attempt */
  offScript?: string;
  /** self-play this decision (the fast-forward tail) */
  auto?: boolean;
  /** guard-test pin: the capture's action at this index must equal this */
  expect?: number;
  /**
   * Extra terms TOUR_LINKS should NOT link in this step's `say`/`offScript`
   * — for a word that's force-linked sitewide in the tour but is used here
   * in its everyday sense rather than the glossary one (see step 0: "the
   * most honest bid in the game" isn't the scoring term).
   */
  skip?: readonly string[];
}

export const COPY = {
  // ---- the pamphlet (concept A, panels ported from the concept board) ----
  cover: {
    dept: 'TOLL DIVISION · RICHMOND',
    stamp: 'EST. 1925',
    title: 'Welcome to the bridge.',
    aside: 'A short pamphlet and one practice deal — three minutes, and you’ll know your way across.',
    begin: 'READ THE PAMPHLET →',
  },
  skip: 'SKIP THE TUTORIAL',
  bridgePanel: {
    no: 'I · THE BRIDGE',
    title: 'A small club, one crossing at a time.',
    body1:
      'Nickel Bridge is a club for learning bridge by playing it. You sit South, always. Your partner is a robot of even temper; your opponents, two more.',
    body2:
      'The people you’re truly playing came before you, and will come after — each one meeting your same cards at their own pace.',
    aside: 'Named for the 1925 toll bridge over the James River: a dime to cross, then a nickel, now fifty cents.',
  },
  ledgerPanel: {
    no: 'II · THE LEDGER',
    title: 'Everyone plays the same deals.',
    body1:
      'Bad cards are no excuse here — Margaret holds the same ones as you, whenever she gets around to them. You’re scored on what you did with the deal, against everyone who held it.',
    // "the game" here means bridge itself, not the scoring term — kept
    // unlinked via the TourProse `skip` override at its call site.
    body2: 'That’s duplicate: the luck is dealt out of the game, and judgment is what’s left.',
  },

  offerNo: 'III · THE PRACTICE',
  offerTitle: 'A practice crossing.',
  offerBody:
    'Before your first real crossing, walk one deal with the tollkeeper. You’ll bid a hand, play a card or two, and learn to read the ledger.',

  offScriptCall: 'A fine thought — and its meaning is right there. But on this crossing, follow the tollkeeper.',
  offScriptCard: 'A fair card — but take the marked one this time. The meanings of your own experiments come later.',
  fastForward:
    'That’s the whole idea — the rest of the hand plays itself. Watch the meter; the house knows when to spend an honor and when to keep one.',

  receiptSay:
    'Scored and itemized — every crossing prints a receipt like this. Read where the toll came from, then see who else was on the bridge.',
  fieldSay:
    'You didn’t cross alone: the house played this very deal before you — same cards, same robots. The Shark and The Regular both landed your exact line, so the three of you split the matchpoints. The Novice held your cards too, and went two down. That’s duplicate: the deal is never the difference.',

  doneTitle: 'That’s the whole game.',
  doneBody:
    'Bid with meaning. Play with care. Read the ledger. From here it counts: four deals a crossing, everyone on the same cards, one ledger between you.',
  doneAside: 'The tollkeeper keeps no record of practice boards.',
} as const;

/**
 * Guidance per captured decision index. Steps 0–2 are the auction, 3–18 the
 * play; anything past this array (or marked auto) self-plays. Card/call
 * numbers in `expect` use the shared encodings in web/src/api.ts.
 */
export const STEPS: StepGuidance[] = [
  {
    // 1NT (call 7). "the game" here means bridge itself, not the scoring
    // term — see `skip` below.
    say: 'Your hand, counted: fifteen high card points (HCP), evenly spread. That’s the most honest bid in the game — tap 1NT and read what it promises. Nothing is final until you confirm.',
    offScript:
      'Each of these has its meaning — that’s the point of the box. Read as many as you like, then bid 1NT: the honest one.',
    expect: 7,
    skip: ['game'],
  },
  {
    // 2♠ (call 11), after partner's Jacoby transfer
    say: 'Marked and filed — every call you make gets graded like that. Now, partner’s 2♥ is a code word. Tap it in the auction and read it. It orders you to say 2♠ — obey.',
    offScript: 'Partner gave an order in code. 2♠ — the transfer must be obeyed.',
    expect: 11,
  },
  {
    // 4♠ (call 21), over partner's choice-of-game 3NT
    say: 'Partner shows five spades and offers a choice of game. You hold three spades — eight trumps between you. Take the game to spades: 4♠.',
    offScript: 'Playable, perhaps — but with eight trumps between you, the spade game rates best. 4♠.',
    expect: 21,
  },
  {
    // dummy's forced ♥10 (card 21) — auto-plays; the ribbon explains dummy
    say: 'West leads, and partner lays their hand on the table. That’s dummy — yours to play too. One heart up there, so it plays itself.',
    expect: 21,
  },
  {
    // S follows with the ♥4 (card 15) — the two-step tap
    say: 'Dummy’s ten is already winning the trick — East couldn’t beat it. Spend nothing: tap your ♥4 to select it, then tap again to play.',
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
