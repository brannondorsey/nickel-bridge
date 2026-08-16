import {
  Call,
  Card,
  Contract,
  Deal,
  SEATS,
  Seat,
  Strain,
  cardRank,
  cardSuit,
  makeCard,
  playState,
  seededRng,
} from '@bridge/core';
import { DecisionKnowledge, WeightedLayout, hoistAuctionConstraints, inferVoids, sampleLayouts } from './play-mc.js';

/**
 * Pop-Up Quiz question generation — pure, engine-level, no DB/Fastify.
 *
 * Mirrors play-mc.ts's shape: a knowledge snapshot built from PUBLIC state
 * only (deriveQuizKnowledge), reused belief sampling (sampleLayouts,
 * hoistAuctionConstraints), and a seeded, deterministic selection so every
 * player on the same board gets a fair, reproducible cadence of quizzes (see
 * CLAUDE.md's "Pop-Up Quiz" section for the full design record).
 *
 * The one thing this module deliberately does NOT do that play-mc.ts's
 * scoreCardsSampled does: solve anything double-dummy. A quiz only needs the
 * SAMPLED LAYOUTS themselves (which seat plausibly holds which cards) — never
 * a DD verdict about how they'd be played — so one sampleLayouts() draw per
 * trigger trick (synchronous, no DDS) is reused across every probabilistic
 * candidate that trick, instead of paying a solve per candidate.
 */

export type QuestionType =
  | 'suit-count'
  | 'opponent-length'
  | 'void'
  | 'trump-count'
  | 'honor-location'
  | 'suit-exhaustion'
  | 'running-total';

export type DifficultyTier = 'easy' | 'medium' | 'hard';

export type QuizFrequency = 'sometimes' | 'often';

/** '2' is South, matching server/src/game.ts's HUMAN_SEAT — duplicated here as
 *  a literal rather than imported, since packages/ai cannot depend on server
 *  (CLAUDE.md's build order: core -> ai -> server -> web). This value carries
 *  no real entropy in this app today (every board's human is South, a
 *  codebase-wide invariant) — it's included in the seed string purely to
 *  satisfy the brief's literal "(board ID, seat, setting)" spec. If seat
 *  assignment is ever made configurable, this literal and HUMAN_SEAT must be
 *  updated together; there is no single source of truth to enforce it, same
 *  as every other place in this codebase that already assumes South. */
const QUIZ_SEED_SEAT_LITERAL = 2;

export function quizSeed(tournamentSeed: string, boardNo: number, freq: QuizFrequency): string {
  return `${tournamentSeed}#board${boardNo}#quiz${QUIZ_SEED_SEAT_LITERAL}#${freq}`;
}

export const QUIZ_RATE: Record<QuizFrequency, { min: number; max: number }> = {
  sometimes: { min: 1, max: 2 },
  often: { min: 3, max: 4 },
};
export const MIN_TRICK = 1;
export const MAX_TRICK = 12; // trick 13 ends the board — no "between tricks" moment after it

/**
 * Which trick numbers (1-based) are eligible to fire a quiz on this board, for
 * this frequency setting — a stratified pick: `n` disjoint windows spanning
 * tricks 1-12, one randomized pick per window, so the cadence is real
 * (non-fixed-interval) but guarantees a minimum spacing. Pure function of
 * (seed, freq) alone: every player with the same setting on the same board
 * gets the identical trick-number assignment, independent of how their own
 * auction or play diverges (see CLAUDE.md for what that guarantee does and
 * does not survive — claims skip trigger checks entirely).
 */
export function triggerTricks(seed: string, freq: QuizFrequency): number[] {
  const { min, max } = QUIZ_RATE[freq];
  const n = seededRng(`${seed}#count`)() < 0.5 ? min : max;
  const window = (MAX_TRICK - MIN_TRICK + 1) / n;
  const picks: number[] = [];
  for (let w = 0; w < n; w++) {
    const lo = MIN_TRICK + Math.ceil(w * window);
    const hi = MIN_TRICK + Math.floor((w + 1) * window) - 1;
    const r = seededRng(`${seed}#pick${w}`)();
    picks.push(Math.min(MAX_TRICK, lo + Math.floor(r * (hi - lo + 1))));
  }
  return picks;
}

/** The per-trick candidate/tier-pick seed — declaring-seat-independent, like `quizSeed` itself. */
function trickSeed(boardQuizSeed: string, trick: number): string {
  return `${boardQuizSeed}#trick${trick}`;
}

/**
 * Sampled-DD layouts per quiz decision. No DD solve at all is needed here
 * (see the module doc comment) — this is purely the belief model's own K, so
 * it's set generously without any per-solve cost concern.
 */
export const QUIZ_SAMPLE_K = 64;

/**
 * A quiz's public-knowledge snapshot: a sibling of play-mc.ts's
 * DecisionKnowledge, decoupled from "whose turn is it" and fixed to exactly
 * the two seats the human can legitimately see — `playingSeat`/`dummySeat`,
 * NEVER the module-level HUMAN_SEAT constant a caller might otherwise reach
 * for. Under the "hand-flip subtlety" (CLAUDE.md), when the human's partner
 * declares, control flips so the human plays THAT hand and their own dealt
 * cards become dummy — a knowledge snapshot fixed to the wrong pair of seats
 * would silently run probabilistic inference over cards the player is
 * looking directly at. `playingSeat`/`dummySeat` must be threaded in from the
 * caller's own flip computation (server/src/game.ts's `playingSeatFor`) —
 * this function never re-derives it.
 */
export type QuizKnowledge = DecisionKnowledge & {
  playingSeat: Seat;
  dummySeat: Seat;
  /** the two seats NOT playingSeat/dummySeat — the only seats a candidate or
   *  option may ever reference for void/suit-exhaustion, and the only seats a
   *  probabilistic candidate reasons about at all */
  hiddenSeats: Seat[];
};

export function deriveQuizKnowledge(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  dealer: Seat,
  calls: Call[],
  playingSeat: Seat,
  dummySeat: Seat,
): QuizKnowledge {
  const knownHands = new Map<Seat, Card[]>();
  knownHands.set(playingSeat, [...deal.hands[playingSeat]]);
  knownHands.set(dummySeat, [...deal.hands[dummySeat]]);
  const hiddenSeats = SEATS.filter((s) => s !== playingSeat && s !== dummySeat);

  const state = playState(deal, contract, plays);
  const playedBySeat: Card[][] = [[], [], [], []];
  for (const trick of [...state.completedTricks, state.currentTrick]) {
    for (const p of trick) playedBySeat[p.seat].push(p.card);
  }
  const handSize = deal.hands[playingSeat].length;
  const remainingCounts = playedBySeat.map((played) => handSize - played.length);
  const deck = deal.hands.flat().sort((a, b) => a - b);

  return {
    // Unused by sampleLayouts/hoistAuctionConstraints (neither reads
    // actor/handToPlay) — present only so this satisfies DecisionKnowledge's
    // shape for reuse of that machinery without a cast.
    actor: playingSeat,
    handToPlay: playingSeat,
    contract,
    dealer,
    calls,
    plays,
    vul: deal.vul,
    handSize,
    deck,
    knownHands,
    playedBySeat,
    remainingCounts,
    voids: inferVoids(contract, plays),
    playingSeat,
    dummySeat,
    hiddenSeats,
  };
}

// ---- shared arithmetic helpers ----

const SUIT_WORDS = ['spades', 'hearts', 'diamonds', 'clubs'];
function suitWord(suit: Strain | number): string {
  return SUIT_WORDS[suit];
}

function remainingInSuit(know: QuizKnowledge, seat: Seat, suit: number): number {
  const hand = know.knownHands.get(seat);
  if (!hand) return 0;
  const total = hand.filter((c) => cardSuit(c) === suit).length;
  const played = know.playedBySeat[seat].filter((c) => cardSuit(c) === suit).length;
  return total - played;
}

function totalPlayedInSuit(know: QuizKnowledge, suit: number): number {
  return know.playedBySeat.flat().filter((c) => cardSuit(c) === suit).length;
}

/** How many cards of `suit` are unaccounted for — not in the two known hands,
 *  not yet played. This is the certain quantity `suit-count`/`trump-count`
 *  ask about directly, and the domain bound `opponent-length` samples within. */
function unaccountedInSuit(know: QuizKnowledge, suit: number): number {
  return 13 - remainingInSuit(know, know.playingSeat, suit) - remainingInSuit(know, know.dummySeat, suit) - totalPlayedInSuit(know, suit);
}

/** 1-based trick each hidden seat first showed out of each suit, or null. */
function voidDiscoveryTrick(contract: Contract, plays: Card[]): (number | null)[][] {
  const stub: Deal = { hands: [[], [], [], []], dealer: 0, vul: { ns: false, ew: false } };
  const state = playState(stub, contract, plays);
  const discovered: (number | null)[][] = SEATS.map(() => [null, null, null, null]);
  state.completedTricks.forEach((trick, ti) => {
    if (trick.length === 0) return;
    const led = cardSuit(trick[0].card);
    for (const p of trick.slice(1)) {
      if (cardSuit(p.card) !== led && discovered[p.seat][led] === null) discovered[p.seat][led] = ti + 1;
    }
  });
  return discovered;
}

/** Build 4 distinct numeric MC options spanning [lo,hi] around `correct`,
 *  order shuffled by the seed so position never leaks correctness. */
function numericOptions(correct: number, lo: number, hi: number, rng: () => number): { options: string[]; correctIndex: number } {
  const vals = new Set<number>([correct]);
  for (const off of [-2, -1, 1, 2, -3, 3, -4, 4]) {
    if (vals.size >= 4) break;
    const v = correct + off;
    if (v >= lo && v <= hi) vals.add(v);
  }
  for (let v = lo; v <= hi && vals.size < 4; v++) vals.add(v);
  const arr = [...vals].sort((a, b) => a - b).slice(0, 4);
  if (!arr.includes(correct)) arr[0] = correct;
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { options: shuffled.map(String), correctIndex: shuffled.indexOf(correct) };
}

function modalOf(dist: Map<number | Seat, number>): { value: number; margin: number } {
  let total = 0;
  let best = -1;
  let bestW = -1;
  for (const [v, w] of dist) {
    total += w;
    if (w > bestW) {
      bestW = w;
      best = v as number;
    }
  }
  return { value: best, margin: total > 0 ? bestW / total : 0 };
}

// ---- candidate shape ----

interface RawCandidate {
  type: QuestionType;
  prompt: string;
  multiSelect: boolean;
  options: string[];
  correctAnswer: number[];
  reasoning: string;
  /** 1-based trick the key evidence became current/known */
  evidenceTrick: number;
  /** probabilistic candidates only (opponent-length, honor-location) — the
   *  sampled distribution's confidence in its own modal answer */
  probMargin?: number;
  /** size of the plausible-answer space; <=1 is "no real uncertainty" */
  possibleValues: number;
}

// ---- type 1: suit-count (certain) ----

function genSuitCount(know: QuizKnowledge, triggerTrick: number, rng: () => number): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (let suit = 0; suit < 4; suit++) {
    const unaccounted = unaccountedInSuit(know, suit);
    if (unaccounted <= 0) continue; // whole suit already visible — trivial, don't even generate
    const { options, correctIndex } = numericOptions(unaccounted, 0, 13, rng);
    const known = remainingInSuit(know, know.playingSeat, suit) + remainingInSuit(know, know.dummySeat, suit);
    out.push({
      type: 'suit-count',
      prompt: `How many ${suitWord(suit)} are still unaccounted for (not in your hand, dummy, or played)?`,
      multiSelect: false,
      options,
      correctAnswer: [correctIndex],
      reasoning: `13 ${suitWord(suit)} in the deck, minus ${known} you can see between your hand and dummy and ${totalPlayedInSuit(know, suit)} already played, leaves ${unaccounted} unaccounted for.`,
      evidenceTrick: triggerTrick,
      possibleValues: 2,
    });
  }
  return out;
}

// ---- type 2: running-total (certain) ----

function genRunningTotal(know: QuizKnowledge, triggerTrick: number, rng: () => number): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (let suit = 0; suit < 4; suit++) {
    const played = totalPlayedInSuit(know, suit);
    if (played < 2) continue; // too few to make a real counting question
    const { options, correctIndex } = numericOptions(played, 0, 13, rng);
    out.push({
      type: 'running-total',
      prompt: `How many ${suitWord(suit)} have been played so far, across all four hands?`,
      multiSelect: false,
      options,
      correctAnswer: [correctIndex],
      reasoning: `${played} ${suitWord(suit)} have appeared in the tricks played so far.`,
      evidenceTrick: triggerTrick,
      possibleValues: 2,
    });
  }
  return out;
}

// ---- type 3: trump-count (certain, neutrally worded — see CLAUDE.md) ----

function genTrumpCount(know: QuizKnowledge, triggerTrick: number, rng: () => number): RawCandidate[] {
  if (know.contract.strain === 4) return []; // no-trump — no trump suit to ask about
  const trump = 3 - know.contract.strain;
  const unaccounted = unaccountedInSuit(know, trump);
  if (unaccounted <= 0) return [];
  const { options, correctIndex } = numericOptions(unaccounted, 0, 13, rng);
  return [
    {
      type: 'trump-count',
      prompt: `How many trumps are still unaccounted for (not visible in either hand on the table, and not yet played)?`,
      multiSelect: false,
      options,
      correctAnswer: [correctIndex],
      reasoning: `13 trumps total; the rest are visible in your hand, dummy, or already played, leaving ${unaccounted} unaccounted for.`,
      evidenceTrick: triggerTrick,
      possibleValues: 2,
    },
  ];
}

// ---- type 4: suit-exhaustion (certain, hidden seats only) ----

function genSuitExhaustion(know: QuizKnowledge, triggerTrick: number, voidTricks: (number | null)[][]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const seat of know.hiddenSeats) {
    const voidedSuits = [0, 1, 2, 3].filter((s) => know.voids[seat][s]);
    if (voidedSuits.length !== 1) continue; // ambiguous or none — skip
    const suit = voidedSuits[0];
    const discovered = voidTricks[seat][suit];
    if (discovered === null) continue;
    out.push({
      type: 'suit-exhaustion',
      prompt: `Which suit has ${SEAT_FULL[seat]} shown out of?`,
      multiSelect: false,
      options: SUIT_WORDS.map((w) => w[0].toUpperCase() + w.slice(1)),
      correctAnswer: [suit],
      reasoning: `${SEAT_FULL[seat]} failed to follow suit in ${suitWord(suit)} at trick ${discovered}, confirming the void.`,
      evidenceTrick: discovered,
      possibleValues: 4,
    });
  }
  return out;
}

const SEAT_FULL = ['North', 'East', 'South', 'West'];

// ---- type 5: void (certain, hidden seats only, multi-select) ----

function genVoid(know: QuizKnowledge, triggerTrick: number, voidTricks: (number | null)[][]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (let suit = 0; suit < 4; suit++) {
    const voided = know.hiddenSeats.filter((s) => know.voids[s][suit]);
    if (!voided.length) continue; // "no candidate with no confirmed void" — avoids a none-of-the-above trick question
    const discovered = Math.max(...voided.map((s) => voidTricks[s][suit] ?? 0));
    out.push({
      type: 'void',
      prompt: `Which hand(s) are known to be void in ${suitWord(suit)}?`,
      multiSelect: true,
      options: know.hiddenSeats.map((s) => SEAT_FULL[s]),
      correctAnswer: know.hiddenSeats.map((s, i) => (know.voids[s][suit] ? i : -1)).filter((i) => i >= 0),
      reasoning: `${voided.map((s) => SEAT_FULL[s]).join(' and ')} failed to follow ${suitWord(suit)} earlier in the hand.`,
      evidenceTrick: discovered,
      possibleValues: 2,
    });
  }
  return out;
}

// ---- type 6: opponent-length (always probabilistic) ----

function genOpponentLength(
  know: QuizKnowledge,
  triggerTrick: number,
  layouts: WeightedLayout[],
  rng: () => number,
): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const seat of know.hiddenSeats) {
    for (let suit = 0; suit < 4; suit++) {
      const hi = unaccountedInSuit(know, suit);
      if (hi <= 0) continue;
      const dist = new Map<number, number>();
      for (const layout of layouts) {
        const total = layout.deal.hands[seat].filter((c) => cardSuit(c) === suit).length;
        const remaining = total - know.playedBySeat[seat].filter((c) => cardSuit(c) === suit).length;
        dist.set(remaining, (dist.get(remaining) ?? 0) + layout.weight);
      }
      const { value, margin } = modalOf(dist);
      if (value < 0) continue;
      const { options, correctIndex } = numericOptions(value, 0, hi, rng);
      out.push({
        type: 'opponent-length',
        prompt: `How many ${suitWord(suit)} does ${SEAT_FULL[seat]} most likely hold, based on the play so far?`,
        multiSelect: false,
        options,
        correctAnswer: [correctIndex],
        reasoning: `Sampling hands consistent with the auction and the play so far, ${SEAT_FULL[seat]} holds ${value} ${suitWord(suit)} in ${Math.round(margin * 100)}% of the layouts tried.`,
        evidenceTrick: triggerTrick,
        probMargin: margin,
        possibleValues: hi + 1,
      });
    }
  }
  return out;
}

// ---- type 7: honor-location (always probabilistic) ----

const HONOR_RANKS = [12, 11, 10, 9]; // A K Q J
const HONOR_CHARS = ['A', 'K', 'Q', 'J'];

function genHonorLocation(
  know: QuizKnowledge,
  triggerTrick: number,
  layouts: WeightedLayout[],
  rng: () => number,
): RawCandidate[] {
  const out: RawCandidate[] = [];
  const playedSet = new Set(know.playedBySeat.flat());
  const known = new Set<Card>();
  for (const [, hand] of know.knownHands) for (const c of hand) known.add(c);

  for (let suit = 0; suit < 4; suit++) {
    for (let i = 0; i < HONOR_RANKS.length; i++) {
      const card = makeCard(suit as 0 | 1 | 2 | 3, HONOR_RANKS[i]);
      if (playedSet.has(card) || known.has(card)) continue; // already placed or gone — not "missing"
      const dist = new Map<Seat, number>();
      for (const layout of layouts) {
        for (const seat of know.hiddenSeats) {
          if (layout.deal.hands[seat].includes(card)) {
            dist.set(seat, (dist.get(seat) ?? 0) + layout.weight);
            break;
          }
        }
      }
      const { value: seat, margin } = modalOf(dist);
      if (seat < 0) continue;
      const optRngLocal = rng; // shuffle order via the shared, already-seeded stream
      const shuffledSeats = [...know.hiddenSeats];
      for (let k = shuffledSeats.length - 1; k > 0; k--) {
        const j = Math.floor(optRngLocal() * (k + 1));
        [shuffledSeats[k], shuffledSeats[j]] = [shuffledSeats[j], shuffledSeats[k]];
      }
      out.push({
        type: 'honor-location',
        prompt: `Where is the missing ${SUIT_SYMBOLS[suit]}${HONOR_CHARS[i]} most likely sitting, given the play so far?`,
        multiSelect: false,
        options: shuffledSeats.map((s) => SEAT_FULL[s]),
        correctAnswer: [shuffledSeats.indexOf(seat as Seat)],
        reasoning: `Sampling hands consistent with the auction and the play so far, ${SEAT_FULL[seat]} holds the ${SUIT_SYMBOLS[suit]}${HONOR_CHARS[i]} in ${Math.round(margin * 100)}% of the layouts tried.`,
        evidenceTrick: triggerTrick,
        probMargin: margin,
        possibleValues: 2,
      });
    }
  }
  return out;
}

const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

// ---- gates ----

/** Fewer than this many tricks left after the trigger trick ⇒ too near the
 *  endgame for a meaningful counting question (the deal is close to fully
 *  known anyway). */
export const LATE_ENDGAME_TRICKS_LEFT = 3;

function isTrivial(c: RawCandidate, triggerTrick: number): boolean {
  if (c.possibleValues <= 1) return true;
  // suit-count/running-total/trump-count are always "current" facts — asking
  // about them the instant after the trick that made them current isn't
  // trivially fresh the way a void/exhaustion candidate would be.
  const exempt = c.type === 'suit-count' || c.type === 'running-total' || c.type === 'trump-count';
  if (!exempt && c.evidenceTrick === triggerTrick) return true;
  if (13 - triggerTrick < LATE_ENDGAME_TRICKS_LEFT) return true;
  if (c.probMargin !== undefined && c.probMargin >= 0.97) return true;
  return false;
}

// ---- difficulty scoring (soft score — buckets, not a gate) ----

export const DIFFICULTY_WEIGHTS = { hops: 0.4, suits: 0.15, recency: 0.2, closeness: 0.25 } as const;

const HOPS: Record<QuestionType, number> = {
  'suit-count': 1,
  'running-total': 1,
  'trump-count': 1,
  'suit-exhaustion': 1,
  void: 2,
  'opponent-length': 3,
  'honor-location': 4,
};

/** For the five certain types: how close the nearest wrong option sits to the
 *  correct one — a near-miss discrimination is harder than a wide spread. */
function closenessFromOptionSpread(c: RawCandidate): number {
  const nums = c.options.map((o) => Number(o));
  if (nums.some((n) => Number.isNaN(n)) || nums.length < 2) return 0;
  const correct = c.correctAnswer.map((i) => nums[i])[0];
  let minDist = Infinity;
  nums.forEach((n, i) => {
    if (!c.correctAnswer.includes(i)) minDist = Math.min(minDist, Math.abs(n - correct));
  });
  if (!Number.isFinite(minDist)) return 0;
  return Math.max(0, 1 - (minDist - 1) / 3);
}

function scoreDifficulty(c: RawCandidate, triggerTrick: number): { score: number; tier: DifficultyTier } {
  const hopsNorm = (HOPS[c.type] - 1) / 3;
  const suitsNorm = 0; // reserved: every v1 type is single-suit
  const recencyNorm = Math.min(1, (triggerTrick - c.evidenceTrick) / 6);
  const closenessNorm = c.probMargin !== undefined ? 1 - Math.min(1, c.probMargin) : closenessFromOptionSpread(c);
  const score =
    DIFFICULTY_WEIGHTS.hops * hopsNorm +
    DIFFICULTY_WEIGHTS.suits * suitsNorm +
    DIFFICULTY_WEIGHTS.recency * recencyNorm +
    DIFFICULTY_WEIGHTS.closeness * closenessNorm;
  const tier: DifficultyTier = score < 0.34 ? 'easy' : score < 0.67 ? 'medium' : 'hard';
  return { score, tier };
}

// ---- selection: the 85%-rule tier split, seeded ----

export const TIER_WEIGHTS: Record<DifficultyTier, number> = { easy: 0.7, medium: 0.25, hard: 0.05 };
const TIER_ORDER: DifficultyTier[] = ['easy', 'medium', 'hard'];

function pickTierAndCandidate(scored: (RawCandidate & { tier: DifficultyTier })[], seed: string): (RawCandidate & { tier: DifficultyTier }) | null {
  if (!scored.length) return null;
  const byTier: Record<DifficultyTier, typeof scored> = { easy: [], medium: [], hard: [] };
  for (const c of scored) byTier[c.tier].push(c);

  const r = seededRng(`${seed}#tier`)();
  let acc = 0;
  let chosen: DifficultyTier = 'hard';
  for (const t of TIER_ORDER) {
    acc += TIER_WEIGHTS[t];
    if (r < acc) {
      chosen = t;
      break;
    }
  }
  let pool = byTier[chosen];
  if (!pool.length) {
    for (const t of TIER_ORDER) {
      if (byTier[t].length) {
        pool = byTier[t];
        break;
      }
    }
  }
  if (!pool.length) return null;
  const idx = Math.floor(seededRng(`${seed}#pick`)() * pool.length);
  return pool[Math.min(idx, pool.length - 1)];
}

// ---- public entry point ----

export interface QuizQuestion {
  type: QuestionType;
  tier: DifficultyTier;
  multiSelect: boolean;
  prompt: string;
  options: string[];
  correctAnswer: number[];
  reasoning: string;
}

/**
 * Generate (or decline to generate) a quiz question for the position right
 * after `triggerTrick` completed. `seed` is the per-trick seed
 * (`trickSeed(quizSeed(...), triggerTrick)` — exported as `trickSeed` isn't
 * needed by callers since `quizSeedForTrick` below composes it).
 *
 * Deterministic given (deal, contract, plays, playingSeat, dummySeat, trick,
 * seed): a golden-fixture test pins this. Returns null whenever nothing
 * clears the triviality gate — the caller treats that exactly like "not a
 * trigger trick" (no quiz, no error).
 */
export function selectQuizQuestion(
  deal: Deal,
  contract: Contract,
  plays: Card[],
  dealer: Seat,
  calls: Call[],
  playingSeat: Seat,
  dummySeat: Seat,
  triggerTrick: number,
  seed: string,
): QuizQuestion | null {
  const know = deriveQuizKnowledge(deal, contract, plays, dealer, calls, playingSeat, dummySeat);
  const voidTricks = voidDiscoveryTrick(contract, plays);
  const constraints = hoistAuctionConstraints(dealer, calls);
  const sampleRng = seededRng(`${seed}#sample`);
  const layouts = sampleLayouts(know, constraints, QUIZ_SAMPLE_K, sampleRng);
  const optRng = seededRng(`${seed}#opts`);

  const raw: RawCandidate[] = [
    ...genSuitCount(know, triggerTrick, optRng),
    ...genRunningTotal(know, triggerTrick, optRng),
    ...genTrumpCount(know, triggerTrick, optRng),
    ...genSuitExhaustion(know, triggerTrick, voidTricks),
    ...genVoid(know, triggerTrick, voidTricks),
    ...genOpponentLength(know, triggerTrick, layouts, optRng),
    ...genHonorLocation(know, triggerTrick, layouts, optRng),
  ];

  const eligible = raw.filter((c) => !isTrivial(c, triggerTrick));
  if (!eligible.length) return null;

  const scored = eligible.map((c) => ({ ...c, ...scoreDifficulty(c, triggerTrick) }));
  const chosen = pickTierAndCandidate(scored, seed);
  if (!chosen) return null;

  return {
    type: chosen.type,
    tier: chosen.tier,
    multiSelect: chosen.multiSelect,
    prompt: chosen.prompt,
    options: chosen.options,
    correctAnswer: chosen.correctAnswer,
    reasoning: chosen.reasoning,
  };
}

/** The per-trick seed a caller feeds into `selectQuizQuestion` — composed
 *  here so `server/src/quiz.ts` never hand-builds the string itself. */
export function quizSeedForTrick(tournamentSeed: string, boardNo: number, freq: QuizFrequency, trick: number): string {
  return trickSeed(quizSeed(tournamentSeed, boardNo, freq), trick);
}
