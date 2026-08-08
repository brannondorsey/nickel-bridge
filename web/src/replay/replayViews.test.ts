import { describe, expect, it } from 'vitest';
import { donePlayed } from '../test/fixtures';
import { buildReplayViews, firstPlyOfTrick, trickOfPly } from './replayViews';

describe('buildReplayViews', () => {
  const views = buildReplayViews(donePlayed);

  it('emits one view per ply plus the start, all locked playing snapshots', () => {
    expect(views).toHaveLength(53);
    for (const v of views) {
      expect(v.state).toBe('playing');
      expect(v.myTurn).toBe(false);
      expect(v.legalCards).toBeUndefined();
    }
  });

  it('consecutive views differ by exactly one card', () => {
    for (let p = 1; p < views.length; p++) {
      const before = (views[p - 1].completedTricks ?? 0) * 4 + (views[p - 1].currentTrick?.length ?? 0);
      const after = (views[p].completedTricks ?? 0) * 4 + (views[p].currentTrick?.length ?? 0);
      expect(after - before).toBe(1);
    }
  });

  it('hands shrink and the trick tallies stay consistent', () => {
    expect(views[0].hand).toHaveLength(13);
    expect(views[52].hand).toHaveLength(0);
    const last = views[52];
    expect((last.declarerTricks ?? 0) + (last.defenderTricks ?? 0)).toBe(13);
    // dummy faces up only after the opening lead
    expect(views[0].dummyHand).toBeUndefined();
    expect(views[1].dummyHand).toHaveLength(13);
  });

  it('trick helpers agree', () => {
    expect(firstPlyOfTrick(1)).toBe(0);
    expect(firstPlyOfTrick(4)).toBe(12);
    expect(trickOfPly(0, 52)).toBe(1);
    expect(trickOfPly(4, 52)).toBe(2);
    expect(trickOfPly(51, 52)).toBe(13);
  });
});
