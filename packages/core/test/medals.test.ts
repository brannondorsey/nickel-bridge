import { describe, expect, it } from 'vitest';
import { MEDAL_TIERS, computeMedalProgress } from '../src/index.js';

const B = 4; // boardsPerTournament, matches server's BOARDS_PER_TOURNAMENT

describe('medal tiers', () => {
  it('is club/diamond/heart/spade at 4/25/100/500', () => {
    expect(MEDAL_TIERS).toEqual([
      { suit: 'c', threshold: 4 },
      { suit: 'd', threshold: 25 },
      { suit: 'h', threshold: 100 },
      { suit: 's', threshold: 500 },
    ]);
  });
});

describe('computeMedalProgress', () => {
  it('starts at 0 tournaments: nothing earned, targeting club, 4 remaining', () => {
    const p = computeMedalProgress(0, 0, B);
    expect(p.earned).toEqual([]);
    expect(p.target).toBe('c');
    expect(p.pct).toBe(0);
    expect(p.tournamentsRemaining).toBe(4);
  });

  it('mid-way through the club span (9 of 16 boards), 3 tournaments in', () => {
    const p = computeMedalProgress(3, 9, B);
    expect(p.earned).toEqual([]);
    expect(p.target).toBe('c');
    expect(p.pct).toBe(56); // round(9/16*100)
    expect(p.tournamentsRemaining).toBe(1);
  });

  it('exactly at the club threshold: earned, now targeting diamond', () => {
    const p = computeMedalProgress(4, 16, B);
    expect(p.earned).toEqual(['c']);
    expect(p.target).toBe('d');
    expect(p.pct).toBe(0);
    expect(p.tournamentsRemaining).toBe(21);
  });

  it('one tournament short of club never earns it, even with a full board span', () => {
    // boards from several simultaneously half-finished tournaments can pile
    // up without any of them actually completing — pct caps at 99, not 100
    const p = computeMedalProgress(3, 16, B);
    expect(p.earned).toEqual([]);
    expect(p.target).toBe('c');
    expect(p.pct).toBe(99);
    expect(p.tournamentsRemaining).toBe(1);
  });

  it('mid-way toward diamond (34 of 84 boards into that span), club already earned', () => {
    const p = computeMedalProgress(8, 16 + 34, B);
    expect(p.earned).toEqual(['c']);
    expect(p.target).toBe('d');
    expect(p.pct).toBe(40); // round(34/84*100)
    expect(p.tournamentsRemaining).toBe(17);
  });

  it('earns diamond at the 25th tournament, now targeting heart', () => {
    const p = computeMedalProgress(25, 100, B);
    expect(p.earned).toEqual(['c', 'd']);
    expect(p.target).toBe('h');
    expect(p.pct).toBe(0);
    expect(p.tournamentsRemaining).toBe(75);
  });

  it('earns heart at the 100th tournament, now targeting spade', () => {
    const p = computeMedalProgress(100, 400, B);
    expect(p.earned).toEqual(['c', 'd', 'h']);
    expect(p.target).toBe('s');
    expect(p.pct).toBe(0);
    expect(p.tournamentsRemaining).toBe(400);
  });

  it('maxes out at the 500th tournament: every medal earned, full bar, nothing remaining', () => {
    const p = computeMedalProgress(500, 2000, B);
    expect(p.earned).toEqual(['c', 'd', 'h', 's']);
    expect(p.target).toBeNull();
    expect(p.pct).toBe(100);
    expect(p.tournamentsRemaining).toBe(0);
  });

  it('stays maxed out well past the 500th tournament', () => {
    const p = computeMedalProgress(612, 2450, B);
    expect(p.earned).toEqual(['c', 'd', 'h', 's']);
    expect(p.target).toBeNull();
    expect(p.pct).toBe(100);
    expect(p.tournamentsRemaining).toBe(0);
  });
});
