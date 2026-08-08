import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Card, Contract } from '@bridge/core';
import { dealBoard } from '@bridge/core';
import { SampledChooseOpts, chooseCardSampled, scoreCardsSampled } from '../src/play-mc.js';

/**
 * Golden pin for the scoreCardsSampled split (invariant 1). The expected
 * cards in fixtures-sampled-golden.json were captured from the PRE-split
 * chooseCardSampled (2026-08-03, commit 2ec3b89) over deterministic deals —
 * covering the pure-argmax path (playTopN 1) and the noisy draw (playTopN >
 * 1), whose correctness depends on the wrapper CONTINUING the same rng
 * stream the sampler consumed. If this test fails after touching play-mc.ts,
 * robot behavior changed: stop and re-read invariant 1 before regenerating
 * anything (the capture script lives in the fixture's `capturedBy` note).
 */
interface GoldenCase {
  name: string;
  seed: string;
  boardNo: number;
  contract: Contract;
  plays: Card[];
  opts: SampledChooseOpts;
  expected: Card;
}

const cases: GoldenCase[] = JSON.parse(
  readFileSync(new URL('./fixtures-sampled-golden.json', import.meta.url), 'utf8'),
).cases;

describe('scoreCardsSampled split golden (invariant 1)', () => {
  it('has both argmax and noisy-draw coverage', () => {
    expect(cases.some((c) => (c.opts.playTopN ?? 1) === 1)).toBe(true);
    expect(cases.some((c) => (c.opts.playTopN ?? 1) > 1)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name}: chooses card ${c.expected}`, async () => {
      const deal = dealBoard(c.seed, c.boardNo);
      const card = await chooseCardSampled(deal, c.contract, c.plays, c.opts);
      expect(card).toBe(c.expected);
    });
  }

  it('scoreCardsSampled argmax over totals agrees with chooseCardSampled at playTopN 1', async () => {
    const c = cases.find((x) => (x.opts.playTopN ?? 1) === 1)!;
    const deal = dealBoard(c.seed, c.boardNo);
    const { legal, totals } = await scoreCardsSampled(deal, c.contract, c.plays, c.opts);
    let best = legal[0];
    for (const card of legal) if ((totals.get(card) ?? 0) > (totals.get(best) ?? 0)) best = card;
    // same totals maximum (ties broken by pickFromSolve in the wrapper)
    expect(totals.get(c.expected)).toBe(totals.get(best));
  });
});
