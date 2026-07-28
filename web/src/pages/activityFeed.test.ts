import { describe, expect, it } from 'vitest';
import type { ActivityResponse } from '../api';
import { ACTIVITY_NOW, activityEmpty, activityResponse } from '../test/fixtures';
import {
  FEED_DAYS,
  MARK_FULL_BOARDS,
  dayLabel,
  groupRuns,
  localDateKey,
  runSentence,
  stripMarks,
  type Run,
} from './activityFeed';

/**
 * These are the tests that matter for this feature: everything here depends on
 * the viewer's clock, and every timestamp is built with the LOCAL Date
 * constructor so the assertions hold in any timezone the suite runs in.
 */

const unix = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);

/** Minimal one-player response, so a test can state exactly one thing. */
function oneUser(events: ActivityResponse['events']): ActivityResponse {
  return { since: 0, players: { '7': { handle: 'Alice', picture: null } }, events };
}

const emptyRun = (over: Partial<Run> = {}): Run => ({
  userId: 7,
  handle: 'Alice',
  block: 'evening',
  at: 0,
  boards: 0,
  eloDelta: null,
  crossings: [],
  milestones: [],
  joined: false,
  ...over,
});

describe('groupRuns', () => {
  it('groups a player’s boards into one run per part of the day', () => {
    const days = groupRuns(activityResponse, ACTIVITY_NOW);
    const today = days.find((d) => d.dateKey === localDateKey(ACTIVITY_NOW))!;
    const alice = today.runs.find((r) => r.userId === 7)!;
    expect(alice.block).toBe('evening');
    expect(alice.boards).toBe(8);
    // Two crossings, only one of which rated — the null must not read as 0.
    expect(alice.crossings).toHaveLength(2);
    expect(alice.eloDelta).toBe(26);
  });

  it('keeps a run’s null Elo delta null when nothing it contains rated', () => {
    const days = groupRuns(
      oneUser([
        { kind: 'board', userId: 7, at: unix(2026, 6, 23, 19, 0) },
        {
          kind: 'crossing',
          userId: 7,
          at: unix(2026, 6, 23, 19, 30),
          tournamentId: 5,
          tournamentName: 'Tournament #5',
          pct: 50,
          rank: 1,
          of: 1,
          eloDelta: null,
        },
      ]),
      ACTIVITY_NOW,
    );
    expect(days[0].runs[0].eloDelta).toBeNull();
  });

  it('splits the same player across blocks and across local midnight', () => {
    const days = groupRuns(
      oneUser([
        { kind: 'board', userId: 7, at: unix(2026, 6, 23, 11, 59) }, // morning
        { kind: 'board', userId: 7, at: unix(2026, 6, 23, 12, 1) }, // afternoon
        { kind: 'board', userId: 7, at: unix(2026, 6, 23, 18, 0) }, // evening
        { kind: 'board', userId: 7, at: unix(2026, 6, 22, 23, 30) }, // previous day
      ]),
      ACTIVITY_NOW,
    );
    const today = days.find((d) => d.dateKey === '2026-07-23')!;
    expect(today.runs.map((r) => r.block)).toEqual(['evening', 'afternoon', 'morning']);
    const yesterday = days.find((d) => d.dateKey === '2026-07-22')!;
    expect(yesterday.runs).toHaveLength(1);
  });

  it('puts the small hours in evening, matching the Home greeting’s cutoffs', () => {
    // timeGreeting returns 'evening' for hours >= 18 OR < 5, so 2 AM belongs to
    // its own calendar day's evening rather than to a fourth block.
    const days = groupRuns(oneUser([{ kind: 'board', userId: 7, at: unix(2026, 6, 23, 2, 0) }]), ACTIVITY_NOW);
    const today = days.find((d) => d.dateKey === '2026-07-23')!;
    expect(today.runs[0].block).toBe('evening');
  });

  it('prints every day in the window, including the ones nobody played', () => {
    const days = groupRuns(activityResponse, ACTIVITY_NOW);
    expect(days).toHaveLength(FEED_DAYS);
    expect(days.some((d) => d.runs.length === 0)).toBe(true);
    // newest first
    expect(days[0].dateKey > days[1].dateKey).toBe(true);
  });

  it('drops events older than the window and events with no known player', () => {
    const days = groupRuns(
      {
        since: 0,
        players: { '7': { handle: 'Alice', picture: null } },
        events: [
          { kind: 'board', userId: 7, at: unix(2026, 6, 1, 12, 0) }, // way outside
          { kind: 'board', userId: 99, at: unix(2026, 6, 23, 12, 0) }, // no handle
        ],
      },
      ACTIVITY_NOW,
    );
    expect(days.every((d) => d.runs.length === 0)).toBe(true);
  });

  it('returns a full week of empty days for a cold start', () => {
    const days = groupRuns(activityEmpty, ACTIVITY_NOW);
    expect(days).toHaveLength(FEED_DAYS);
    expect(days.every((d) => d.runs.length === 0)).toBe(true);
  });
});

describe('dayLabel', () => {
  it('names today and yesterday, then falls back to the weekday', () => {
    expect(dayLabel('2026-07-23', ACTIVITY_NOW)).toBe('Today');
    expect(dayLabel('2026-07-22', ACTIVITY_NOW)).toBe('Yesterday');
    expect(dayLabel('2026-07-20', ACTIVITY_NOW)).toBe('Monday');
  });
});

describe('runSentence', () => {
  it('says so when somebody only just arrived', () => {
    expect(runSentence(emptyRun({ joined: true }))).toBe('paid the first toll — no boards yet');
  });

  it('reports a single crossing with its place in the field', () => {
    expect(
      runSentence(
        emptyRun({
          boards: 4,
          crossings: [
            {
              kind: 'crossing',
              userId: 7,
              at: 0,
              tournamentId: 41,
              tournamentName: 'Tournament #41',
              pct: 62,
              rank: 2,
              of: 5,
              eloDelta: 26,
            },
          ],
        }),
      ),
    ).toBe('4 boards · finished №41 — 62%, 2nd of 5');
  });

  it('summarises several crossings by the best of them', () => {
    const crossing = (pct: number) =>
      ({
        kind: 'crossing',
        userId: 7,
        at: 0,
        tournamentId: 1,
        tournamentName: 'Tournament #1',
        pct,
        rank: 1,
        of: 4,
        eloDelta: 1,
      }) as const;
    expect(runSentence(emptyRun({ boards: 12, crossings: [crossing(54), crossing(48), crossing(51)] }))).toBe(
      '12 boards · 3 crossings, best 54%',
    );
  });

  it('leads with a milestone when there is one', () => {
    expect(
      runSentence(
        emptyRun({
          boards: 4,
          milestones: [{ kind: 'milestone', userId: 7, at: 0, milestone: 'entered-rankings' }],
        }),
      ),
    ).toBe('4 boards · entered the rankings');
    // ...but a milestone earned on one crossing keeps that crossing's result,
    // rather than throwing away the more interesting half of the sentence.
    expect(
      runSentence(
        emptyRun({
          boards: 4,
          milestones: [{ kind: 'milestone', userId: 7, at: 0, milestone: 'first-crossing' }],
          crossings: [
            {
              kind: 'crossing',
              userId: 7,
              at: 0,
              tournamentId: 38,
              tournamentName: 'Tournament #38',
              pct: 68,
              rank: 1,
              of: 4,
              eloDelta: 19,
            },
          ],
        }),
      ),
    ).toBe('4 boards · first crossing finished — 68%, 1st of 4');
    expect(
      runSentence(
        emptyRun({
          boards: 4,
          milestones: [{ kind: 'milestone', userId: 7, at: 0, milestone: 'peak-rating', value: 1502 }],
        }),
      ),
    ).toBe('4 boards · a new best rating — 1502');
  });

  it('announces the highest of several new bests, not the first', () => {
    // A long sitting can set a new best several times over, and the events
    // arrive oldest-first. Printing 1210 would name a number they had already
    // beaten by the end of the block.
    const peak = (value: number) => ({ kind: 'milestone', userId: 7, at: 0, milestone: 'peak-rating', value }) as const;
    expect(runSentence(emptyRun({ boards: 20, milestones: [peak(1210), peak(1244), peak(1263)] }))).toBe(
      '20 boards · a new best rating — 1263',
    );
  });

  it('ranks milestones by weight, not by when they happened', () => {
    const ms = [
      { kind: 'milestone', userId: 7, at: 0, milestone: 'peak-rating', value: 1263 },
      { kind: 'milestone', userId: 7, at: 0, milestone: 'entered-rankings' },
    ] as const;
    expect(runSentence(emptyRun({ boards: 20, milestones: [...ms] }))).toBe('20 boards · entered the rankings');
  });

  it('is honest about a run that finished nothing, and counts one board singular', () => {
    expect(runSentence(emptyRun({ boards: 1 }))).toBe('1 board · nothing finished yet');
  });

  describe('board counts the crossings do not account for', () => {
    const crossing = (over: Record<string, unknown> = {}) =>
      ({
        kind: 'crossing',
        userId: 7,
        at: 0,
        tournamentId: 41,
        tournamentName: 'Tournament #41',
        pct: 62,
        rank: 2,
        of: 5,
        eloDelta: 26,
        ...over,
      }) as const;

    it('stays brief when a run started a crossing it did not finish', () => {
      // Six boards can't be one crossing, which is exactly four — the other two
      // are a tournament left unfinished. A clause accounting for the
      // difference was tried and cut; the line reports what someone did, not a
      // balance sheet.
      expect(runSentence(emptyRun({ boards: 6, crossings: [crossing()] }))).toBe(
        '6 boards · finished №41 — 62%, 2nd of 5',
      );
      expect(runSentence(emptyRun({ boards: 10, crossings: [crossing(), crossing({ pct: 55 })] }))).toBe(
        '10 boards · 2 crossings, best 62%',
      );
    });

    it('stays brief when a crossing finished on this run’s first board', () => {
      // The mismatch runs the other way too — the other three boards were
      // played in an earlier block. Equally ordinary, equally unremarked.
      expect(runSentence(emptyRun({ boards: 1, crossings: [crossing()] }))).toBe(
        '1 board · finished №41 — 62%, 2nd of 5',
      );
    });

    it('reads the same when the boards do divide exactly', () => {
      expect(runSentence(emptyRun({ boards: 4, crossings: [crossing()] }))).toBe(
        '4 boards · finished №41 — 62%, 2nd of 5',
      );
      expect(runSentence(emptyRun({ boards: 8, crossings: [crossing(), crossing({ pct: 55 })] }))).toBe(
        '8 boards · 2 crossings, best 62%',
      );
    });
  });
});

describe('stripMarks', () => {
  /** One run of `boards` boards, all at 6 PM, on 23 Jul. */
  const markFor = (boards: number) => {
    const days = groupRuns(
      oneUser(
        Array.from({ length: boards }, (_, i) => ({
          kind: 'board' as const,
          userId: 7,
          at: unix(2026, 6, 23, 18, i),
        })),
      ),
      ACTIVITY_NOW,
    );
    return stripMarks(days.find((d) => d.dateKey === '2026-07-23')!)[0];
  };

  it('places a mark by its local time of day', () => {
    // One board, so the mark sits exactly on the hour — markFor spreads longer
    // runs a minute apart and the mark follows the run's LAST board.
    const mark = markFor(1);
    expect(mark.x).toBeCloseTo(18 / 24, 5);
    expect(mark.kind).toBe('run');
  });

  it('draws a join as a quiet mark rather than a run of boards', () => {
    const days = groupRuns(oneUser([{ kind: 'joined', userId: 7, at: unix(2026, 6, 23, 19, 15) }]), ACTIVITY_NOW);
    const [mark] = stripMarks(days.find((d) => d.dateKey === '2026-07-23')!);
    expect(mark.kind).toBe('join');
    // Shorter than any real run, so it is told apart by height and not only by
    // colour — no board count can produce a mark this small.
    expect(mark.height).toBeLessThan(markFor(1).height);
  });

  it('caps a marathon at full height instead of overrunning the rule', () => {
    expect(markFor(MARK_FULL_BOARDS).height).toBe(1);
    expect(markFor(MARK_FULL_BOARDS * 2).height).toBe(1);
  });

  // The log scale exists to do two things a linear one can't do at once, so
  // these are the properties worth pinning rather than the exact numbers.
  it('keeps an ordinary crossing clearly visible', () => {
    expect(markFor(4).height).toBeGreaterThan(0.45);
  });

  it('still separates a long sitting from a merely busy one', () => {
    expect(markFor(20).height).toBeGreaterThan(markFor(12).height);
    expect(markFor(12).height).toBeGreaterThan(markFor(8).height);
    expect(markFor(8).height).toBeGreaterThan(markFor(4).height);
  });

  it('never lets a single board fall below the floor', () => {
    expect(markFor(1).height).toBe(0.3);
  });
});
