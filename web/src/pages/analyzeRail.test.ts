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

  it('a crowded field is sampled to the dot budget: YOU and the extremes always, then the modes, remainder counted', () => {
    // 13 distinct scores across 20 tables — far past the budget. The mode
    // (620 × 6) must survive; so must YOU (−800, a singleton) and both
    // extremes; and every omitted table is counted, never silently dropped.
    const field = [
      ...Array.from({ length: 6 }, () => ({ score: 620, contract: '4♠ by S', you: false })),
      ...Array.from({ length: 3 }, () => ({ score: 650, contract: '4♠+1 by S', you: false })),
      { score: -800, contract: '5♥X by S −3', you: true },
      { score: 1440, contract: '6NT by S', you: false },
      ...Array.from({ length: 9 }, (_, i) => ({ score: 100 + i * 10, contract: 'partials', you: false })),
    ];
    const l = railLayout(field, 620);
    expect(l.dots.length).toBeLessThanOrEqual(8);
    const scores = l.dots.map((d) => d.score);
    expect(scores).toContain(-800); // YOU (also the min here)
    expect(scores).toContain(1440); // the max
    expect(scores).toContain(620); // the mode
    expect(l.dots.find((d) => d.score === 620)!.count).toBe(6);
    expect(l.dots.some((d) => d.you)).toBe(true);
    // 20 tables, ≤8 dots shown — the rest are counted
    const shown = l.dots.reduce((n, d) => n + d.count, 0);
    expect(l.omittedTables).toBe(20 - shown);
    expect(l.omittedTables).toBeGreaterThan(0);
    // and the survivors still keep readable spacing
    const xs = l.dots.map((d) => d.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(0.08 - 1e-9);
  });

  it('a small field is never sampled', () => {
    const l = railLayout(
      [
        { score: 620, contract: 'a', you: true },
        { score: -100, contract: 'b', you: false },
        { score: 650, contract: 'c', you: false },
      ],
      620,
    );
    expect(l.dots).toHaveLength(3);
    expect(l.omittedTables).toBe(0);
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

  it('omitting rehearsal scores leaves the field untouched', () => {
    const l = railLayout(
      [
        { score: 620, contract: '4♠ by S', you: true },
        { score: 650, contract: '4♠+1 by S', you: false },
      ],
      620,
    );
    expect(l.rehearsalDots).toEqual([]);
  });

  it('colours a rehearsal tick against the real table, not against par', () => {
    // par is 100, YOUR table (the `you` entry) is −800 — a rehearsal beating
    // −800 is green even though it is still nowhere near par
    const l = railLayout(
      [
        { score: -800, contract: '4♥X by S −3', you: true },
        { score: 50, contract: '4♠ by W −1', you: false },
      ],
      100,
      [-500, -800, 200],
    );
    const byScore = new Map(l.rehearsalDots.map((d) => [d.score, d]));
    expect(byScore.get(-500)!.better).toBe(true); // −500 beats −800
    expect(byScore.get(-800)!.better).toBe(null); // tie with your own table
    expect(byScore.get(200)!.better).toBe(true);
    expect(l.rehearsalDots).toHaveLength(3);
  });

  it('merges rehearsal attempts sharing a score and counts them', () => {
    const l = railLayout([{ score: 620, contract: '4♠ by S', you: true }], 620, [500, 500, 500]);
    expect(l.rehearsalDots).toHaveLength(1);
    expect(l.rehearsalDots[0]).toMatchObject({ score: 500, count: 3, better: false });
  });

  it('a rehearsal outlier stretches the same frame the field dots sit in', () => {
    const l = railLayout(
      [
        { score: 620, contract: '4♠ by S', you: true },
        { score: 650, contract: '4♠+1 by S', you: false },
      ],
      620,
      [1440], // grand slam make — far outside the field's own 620-650 range
    );
    expect(l.rehearsalDots[0].x).toBeLessThanOrEqual(0.93 + 1e-9);
    expect(l.rehearsalDots[0].x).toBeGreaterThan(l.dots[l.dots.length - 1].x);
  });
});
