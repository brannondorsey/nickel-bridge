import { describe, expect, it } from 'vitest';
import { Card, Contract, Deal, PASS, Seat, dealBoard, legalCards, makeBid, playState } from '@bridge/core';
import { chooseCard } from '../src/play-ai.js';
import {
  LATE_ENDGAME_TRICKS_LEFT,
  QUIZ_RATE,
  deriveQuizKnowledge,
  quizSeed,
  quizSeedForTrick,
  selectQuizQuestion,
  triggerTricks,
} from '../src/quiz.js';

const quietCalls = [PASS, PASS, PASS, PASS];

/** Play a full true-DD hand out (both sides best play) so quiz tests have a
 *  realistic, void-bearing plays[] to work from — mirrors the deterministic
 *  playout tools/gen_trace_fixture.mjs uses. */
async function playOut(deal: Deal, contract: Contract): Promise<Card[]> {
  const plays: Card[] = [];
  for (let i = 0; i < 52; i++) {
    const legal = legalCards(deal, playState(deal, contract, plays));
    if (!legal.length) break;
    plays.push(await chooseCard(deal, contract, plays));
  }
  return plays;
}

describe('deriveQuizKnowledge — the flip case', () => {
  // North declares (partner of South, the human) — control flips, so the
  // quiz must reason about {North, South} as known, never {South} alone.
  const deal = dealBoard('quiz-flip', 3);
  const contract: Contract = { level: 3, strain: 4, declarer: 0, doubled: false, redoubled: false };

  it('knownHands is exactly {playingSeat, dummySeat}, never a bare HUMAN_SEAT', () => {
    const know = deriveQuizKnowledge(deal, contract, [], deal.dealer, quietCalls, 0, 2);
    expect(new Set(know.knownHands.keys())).toEqual(new Set([0, 2]));
    expect(know.hiddenSeats.sort()).toEqual([1, 3]);
  });

  it('never exposes a hidden seat’s cards outside the public deck', () => {
    const know = deriveQuizKnowledge(deal, contract, [], deal.dealer, quietCalls, 0, 2);
    const visible = new Set([...know.knownHands.get(0)!, ...know.knownHands.get(2)!]);
    for (const seat of [1, 3] as Seat[]) {
      for (const c of deal.hands[seat]) expect(visible.has(c)).toBe(false);
    }
  });
});

describe('quizSeed / triggerTricks', () => {
  it('quizSeed is a pure function of (tournamentSeed, boardNo, freq)', () => {
    expect(quizSeed('abc', 3, 'often')).toBe(quizSeed('abc', 3, 'often'));
    expect(quizSeed('abc', 3, 'often')).not.toBe(quizSeed('abc', 3, 'sometimes'));
    expect(quizSeed('abc', 3, 'often')).not.toBe(quizSeed('abc', 4, 'often'));
  });

  it('triggerTricks takes no game-history input — deterministic from (seed, freq) alone', () => {
    const seed = quizSeed('abc', 3, 'often');
    expect(triggerTricks(seed, 'often')).toEqual(triggerTricks(seed, 'often'));
  });

  for (const freq of ['sometimes', 'often'] as const) {
    it(`${freq}: picks within [min,max] tricks, all in [1,12], strictly sorted`, () => {
      for (let b = 1; b <= 20; b++) {
        const picks = triggerTricks(quizSeed('sweep', b, freq), freq);
        expect(picks.length).toBeGreaterThanOrEqual(QUIZ_RATE[freq].min);
        expect(picks.length).toBeLessThanOrEqual(QUIZ_RATE[freq].max);
        for (const p of picks) {
          expect(p).toBeGreaterThanOrEqual(1);
          expect(p).toBeLessThanOrEqual(12);
        }
        for (let i = 1; i < picks.length; i++) expect(picks[i]).toBeGreaterThan(picks[i - 1]);
      }
    });
  }
});

describe('selectQuizQuestion', () => {
  const deal = dealBoard('quiz-golden', 7);
  const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };

  it('is deterministic: identical inputs give byte-identical output', async () => {
    const plays = await playOut(deal, contract);
    const seed = quizSeedForTrick('quiz-golden', 7, 'often', 5);
    const a = selectQuizQuestion(deal, contract, plays.slice(0, 20), deal.dealer, quietCalls, 2, 0, 5, seed);
    const b = selectQuizQuestion(deal, contract, plays.slice(0, 20), deal.dealer, quietCalls, 2, 0, 5, seed);
    expect(a).toEqual(b);
  });

  it('late-endgame trigger tricks (11, 12) never survive the gate', async () => {
    const plays = await playOut(deal, contract);
    for (const trick of [11, 12]) {
      const seed = quizSeedForTrick('quiz-golden', 7, 'often', trick);
      const q = selectQuizQuestion(deal, contract, plays.slice(0, trick * 4), deal.dealer, quietCalls, 2, 0, trick, seed);
      expect(q).toBeNull();
    }
  });

  it('never references the known seats (playingSeat/dummySeat) in a void or suit-exhaustion option list', async () => {
    // Sweep many boards/tricks/seeds until we've exercised at least one
    // void/suit-exhaustion question, and check its option list every time.
    let sawHiddenSeatType = false;
    for (let b = 1; b <= 12; b++) {
      const d = dealBoard(`quiz-sweep-${b}`, (b % 4) + 1);
      const c: Contract = { level: 3, strain: (b % 5) as 0 | 1 | 2 | 3 | 4, declarer: 2, doubled: false, redoubled: false };
      const plays = await playOut(d, c);
      for (let trick = 4; trick <= 9; trick++) {
        const seed = quizSeedForTrick(`quiz-sweep-${b}`, (b % 4) + 1, 'often', trick);
        const q = selectQuizQuestion(d, c, plays.slice(0, trick * 4), d.dealer, quietCalls, 2, 0, trick, seed);
        if (!q || (q.type !== 'void' && q.type !== 'suit-exhaustion')) continue;
        sawHiddenSeatType = true;
        for (const opt of q.options) {
          expect(opt).not.toBe('South');
          expect(opt).not.toBe('North'); // South is playingSeat=2, North is dummySeat=0 in this fixture
        }
      }
    }
    expect(sawHiddenSeatType).toBe(true);
  }, 20000);

  it('opponent-length and honor-location are reachable, not silently filtered as trivial', async () => {
    // Regression test: genOpponentLength/genHonorLocation always stamp
    // evidenceTrick as the trigger trick itself (there's no discrete "became
    // known" moment for a continuously-updated probabilistic belief), which
    // used to trip isTrivial's freshness check unconditionally since these
    // two types weren't in its exempt list — 0 of either type could ever be
    // generated. Sweep enough boards/tricks that both types should surface
    // at least once if the exemption is correctly in place.
    const seen = new Set<string>();
    for (let b = 1; b <= 15; b++) {
      const d = dealBoard(`quiz-prob-${b}`, (b % 4) + 1);
      const c: Contract = { level: 3, strain: (b % 5) as 0 | 1 | 2 | 3 | 4, declarer: 2, doubled: false, redoubled: false };
      const plays = await playOut(d, c);
      for (let trick = 1; trick <= 9; trick++) {
        const seed = quizSeedForTrick(`quiz-prob-${b}`, (b % 4) + 1, 'often', trick);
        const q = selectQuizQuestion(d, c, plays.slice(0, trick * 4), d.dealer, quietCalls, 2, 0, trick, seed);
        if (q) seen.add(q.type);
      }
    }
    expect(seen.has('opponent-length')).toBe(true);
    expect(seen.has('honor-location')).toBe(true);
  }, 20000);

  it('difficulty tiers realize as a real distribution, easy predominant, across many trigger points', async () => {
    const tiers: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
    for (let b = 1; b <= 10; b++) {
      const d = dealBoard(`quiz-tier-${b}`, (b % 4) + 1);
      const c: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };
      const plays = await playOut(d, c);
      for (let trick = 1; trick <= 9; trick++) {
        const seed = quizSeedForTrick(`quiz-tier-${b}`, (b % 4) + 1, 'often', trick);
        const q = selectQuizQuestion(d, c, plays.slice(0, trick * 4), d.dealer, quietCalls, 2, 0, trick, seed);
        if (q) tiers[q.tier]++;
      }
    }
    const total = tiers.easy + tiers.medium + tiers.hard;
    expect(total).toBeGreaterThan(20);
    expect(tiers.easy).toBeGreaterThan(0);
    // Loose sanity, not a calibration check (see CLAUDE.md's launch-estimate
    // note on DIFFICULTY_WEIGHTS/HOPS) — easy should still be the plurality.
    expect(tiers.easy).toBeGreaterThanOrEqual(tiers.hard);
  }, 20000);
});

describe('bidding-noise interaction (sanity)', () => {
  it('an auction with real hand constraints still produces sane, legal-option questions', async () => {
    const deal = dealBoard('quiz-auction', 2);
    const contract: Contract = { level: 1, strain: 3, declarer: deal.dealer, doubled: false, redoubled: false };
    const calls = [makeBid(1, 3), PASS, PASS, PASS];
    const plays = await playOut(deal, contract);
    const playingSeat = deal.dealer;
    const dummySeat = ((deal.dealer + 2) % 4) as Seat;
    for (let trick = 4; trick <= 8; trick++) {
      const seed = quizSeedForTrick('quiz-auction', 2, 'often', trick);
      const q = selectQuizQuestion(deal, contract, plays.slice(0, trick * 4), deal.dealer, calls, playingSeat, dummySeat, trick, seed);
      if (!q) continue;
      expect(q.options.length).toBeGreaterThan(0);
      expect(q.correctAnswer.length).toBeGreaterThan(0);
      for (const idx of q.correctAnswer) expect(idx).toBeGreaterThanOrEqual(0);
    }
  });
});

// keep LATE_ENDGAME_TRICKS_LEFT's export exercised (documents the constant used above)
describe('LATE_ENDGAME_TRICKS_LEFT', () => {
  it('is 3', () => {
    expect(LATE_ENDGAME_TRICKS_LEFT).toBe(3);
  });
});
