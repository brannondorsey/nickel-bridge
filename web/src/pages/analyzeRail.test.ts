import { describe, expect, it } from 'vitest';
import { railLayout } from './analyzeRail';

describe('the worth rail layout', () => {
  it('orders dots by score, higher-for-your-side further right', () => {
    const l = railLayout(
      [
        { score: -460, contract: '3NT by W +2', you: true },
        { score: -180, contract: '2NT by W +2', you: false },
        { score: -430, contract: '3NT by W +1', you: false },
      ],
      -400,
    );
    expect(l.dots.map((d) => d.score)).toEqual([-460, -430, -180]);
    const xs = l.dots.map((d) => d.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    // par sits between −460 and −180 on the same transform
    expect(l.gate).toBeGreaterThan(xs[0]);
    expect(l.gate).toBeLessThan(xs[2]);
  });

  it('merges tables sharing a score into one counted dot that keeps the YOU flag', () => {
    const l = railLayout(
      [
        { score: 620, contract: '4♠ by S', you: false },
        { score: 620, contract: '4♠ by S', you: true },
        { score: 650, contract: '4♠+1 by S', you: false },
      ],
      620,
    );
    expect(l.dots).toHaveLength(2);
    const shared = l.dots.find((d) => d.score === 620)!;
    expect(shared.count).toBe(2);
    expect(shared.you).toBe(true);
    expect(shared.contracts).toEqual(['4♠ by S']);
  });

  it('an outlier stays in frame and the relaxation keeps the cluster readable', () => {
    const l = railLayout(
      [
        { score: -1100, contract: '5♦X by S −5', you: true },
        { score: 620, contract: '4♠ by S', you: false },
        { score: 650, contract: '4♠+1 by S', you: false },
      ],
      620,
    );
    const [disaster, made, over] = l.dots.map((d) => d.x);
    // everything clamped inside the frame
    for (const x of [disaster, made, over, l.gate]) {
      expect(x).toBeGreaterThanOrEqual(0.07);
      expect(x).toBeLessThanOrEqual(0.93 + 1e-9);
    }
    // 30 points of a 1750-point span is under 2% linearly — the min-gap
    // relaxation pushes the pair apart to the readable floor
    expect(over - made).toBeGreaterThanOrEqual(0.08 - 1e-9);
    // and order is preserved
    expect(disaster).toBeLessThan(made);
  });

  it('a crowded frame shrinks the gap instead of overflowing', () => {
    const field = Array.from({ length: 14 }, (_, i) => ({
      score: 600 + i, // 14 near-ties: full MIN_GAP would need more axis than exists
      contract: 'c',
      you: i === 0,
    }));
    const l = railLayout(field, 620);
    const xs = l.dots.map((d) => d.x);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0.07 - 1e-9);
      expect(x).toBeLessThanOrEqual(0.93 + 1e-9);
    }
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it('alternates label bands along the rail so neighbours never collide', () => {
    const l = railLayout(
      [
        { score: -460, contract: 'a', you: true },
        { score: -430, contract: 'b', you: false },
        { score: -400, contract: 'c', you: false },
        { score: -180, contract: 'd', you: false },
      ],
      -400,
    );
    expect(l.dots.map((d) => d.up)).toEqual([false, true, false, true]);
  });

  it('a degenerate field (every score equal to par) centres everything', () => {
    const l = railLayout(
      [
        { score: 620, contract: '4♠ by S', you: true },
        { score: 620, contract: '4♠ by S', you: false },
      ],
      620,
    );
    expect(l.dots).toHaveLength(1);
    expect(l.dots[0].x).toBe(0.5);
    expect(l.gate).toBe(0.5);
  });
});
