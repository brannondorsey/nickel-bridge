import { describe, expect, it } from 'vitest';
import { Contract, PASS, dealBoard, legalCards, playState } from '@bridge/core';
import { chooseCard } from '../src/play-ai.js';
import { quizSeedForTrick, selectQuizQuestion } from '../src/quiz.js';

/**
 * Golden-fixture pin for the quiz generator's own determinism, mirroring
 * packages/ai/test/play-mc-golden.test.ts's shape: fixed positions, exact
 * candidate/gate/tier/prompt output. This tests the GENERATOR's own
 * reproducibility — it does not and should not assert that two different
 * players see identical content, since that isn't true in general (see
 * CLAUDE.md's Pop-Up Quiz section).
 */
describe('selectQuizQuestion — golden fixture', () => {
  it('pins exact output for a fixed board/trick/seed', async () => {
    const deal = dealBoard('quiz-golden-pin', 5);
    const contract: Contract = { level: 3, strain: 4, declarer: 2, doubled: false, redoubled: false };
    const plays: number[] = [];
    for (let i = 0; i < 24; i++) {
      const legal = legalCards(deal, playState(deal, contract, plays));
      if (!legal.length) break;
      plays.push(await chooseCard(deal, contract, plays));
    }
    const seed = quizSeedForTrick('quiz-golden-pin', 5, 'often', 4);
    const q = selectQuizQuestion(deal, contract, plays.slice(0, 16), deal.dealer, [PASS, PASS, PASS, PASS], 2, 0, 4, seed);
    expect(q).toMatchSnapshot();
  });

  it('a different seed at the same position may pick a different candidate, but is itself stable', async () => {
    const deal = dealBoard('quiz-golden-pin-2', 9);
    const contract: Contract = { level: 4, strain: 3, declarer: 2, doubled: false, redoubled: false };
    const plays: number[] = [];
    for (let i = 0; i < 24; i++) {
      const legal = legalCards(deal, playState(deal, contract, plays));
      if (!legal.length) break;
      plays.push(await chooseCard(deal, contract, plays));
    }
    const seedA = quizSeedForTrick('quiz-golden-pin-2', 9, 'sometimes', 6);
    const a1 = selectQuizQuestion(deal, contract, plays.slice(0, 24), deal.dealer, [PASS, PASS, PASS, PASS], 2, 0, 6, seedA);
    const a2 = selectQuizQuestion(deal, contract, plays.slice(0, 24), deal.dealer, [PASS, PASS, PASS, PASS], 2, 0, 6, seedA);
    expect(a1).toEqual(a2);
    expect(a1).toMatchSnapshot();
  });
});
