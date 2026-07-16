import { describe, expect, it } from 'vitest';
import { DOUBLE, PASS, REDOUBLE, explainBid, makeBid } from '../src/index.js';

/**
 * Data-driven SAYC explainer spec: one row per rule family.
 *
 * Growing the explainer = appending rows here. Each row states the auction
 * (dealer North unless noted), the candidate call for the seat to act, and
 * what the explanation must contain. Keep expectations behavioral (title
 * fragments, point ranges, artificial flag) — not exact prose.
 */
const b = makeBid; // b(level, strain): strains 0=♣ 1=♦ 2=♥ 3=♠ 4=NT

interface Row {
  name: string;
  dealer?: 0 | 1 | 2 | 3;
  calls: number[];
  candidate: number;
  title?: string; // substring match
  points?: string; // exact `points` field
  artificial?: boolean;
  forcing?: 'one-round' | 'game' | null; // null asserts NOT forcing
  exact?: boolean; // explanation is pamphlet-exact (default true)
}

const SPEC: Row[] = [
  // ---- openings ----
  { name: '1♣ opening', calls: [], candidate: b(1, 0), title: '1♣ opening', points: '13–21 pts' },
  { name: '1♦ opening', calls: [], candidate: b(1, 1), title: '1♦ opening', points: '13–21 pts' },
  { name: '1♥ opening promises 5', calls: [], candidate: b(1, 2), title: '1♥ opening', points: '13–21 pts' },
  { name: '1NT opening', calls: [], candidate: b(1, 4), title: '1NT opening', points: '15–17 HCP' },
  { name: '2♣ strong artificial', calls: [], candidate: b(2, 0), title: '2♣ opening', artificial: true, forcing: 'one-round' },
  { name: 'weak two', calls: [], candidate: b(2, 3), title: 'Weak two', points: '5–11 HCP' },
  { name: '2NT opening', calls: [], candidate: b(2, 4), title: '2NT opening', points: '20–21 HCP' },
  { name: '3-level preempt', calls: [], candidate: b(3, 2), title: 'Preempt', points: '5–10 HCP' },
  { name: 'opening pass', calls: [], candidate: PASS, title: 'Pass', points: '0–12 pts' },

  // ---- responses to suit openings ----
  { name: 'single raise', calls: [b(1, 3), PASS], candidate: b(2, 3), title: 'Single raise', points: '6–10 pts' },
  { name: 'limit raise', calls: [b(1, 3), PASS], candidate: b(3, 3), title: 'Limit raise', points: '10–12 pts', forcing: null },
  { name: '1NT response', calls: [b(1, 2), PASS], candidate: b(1, 4), title: '1NT response', points: '6–10 pts' },
  { name: 'new suit 1-level forcing', calls: [b(1, 0), PASS], candidate: b(1, 3), title: 'New suit at the 1 level', points: '6+ pts', forcing: 'one-round' },
  { name: 'two-over-one', calls: [b(1, 3), PASS], candidate: b(2, 1), title: 'New suit at the 2 level', points: '10+ pts' },
  { name: 'jump shift response', calls: [b(1, 0), PASS], candidate: b(2, 3), title: 'Jump shift', points: '17+ pts', forcing: 'game' },
  { name: 'jump shift is a single jump only', calls: [b(1, 2), PASS], candidate: b(2, 3), title: 'Jump shift', points: '17+ pts' },
  { name: 'splinter 4♣ over 1♥', calls: [b(1, 2), PASS], candidate: b(4, 0), title: 'Splinter', points: '10–13 pts', artificial: true, forcing: 'game' },
  { name: 'splinter 3♠ over 1♥', calls: [b(1, 2), PASS], candidate: b(3, 3), title: 'Splinter', points: '10–13 pts', artificial: true },
  { name: 'splinter 4♥ over 1♠', calls: [b(1, 3), PASS], candidate: b(4, 2), title: 'Splinter', points: '10–13 pts', artificial: true },
  { name: 'no splinter over a minor — honest fallback', calls: [b(1, 0), PASS], candidate: b(3, 3), exact: false },
  { name: 'weak response pass', calls: [b(1, 3), PASS], candidate: PASS, points: '0–5 pts' },

  // ---- notrump machinery ----
  { name: 'Stayman', calls: [b(1, 4), PASS], candidate: b(2, 0), title: 'Stayman', artificial: true },
  { name: 'transfer to hearts', calls: [b(1, 4), PASS], candidate: b(2, 1), title: 'transfer to ♥', artificial: true },
  { name: 'transfer to spades', calls: [b(1, 4), PASS], candidate: b(2, 2), title: 'transfer to ♠', artificial: true },
  { name: '2NT invite', calls: [b(1, 4), PASS], candidate: b(2, 4), title: '2NT invitation', points: '8–9 HCP' },
  { name: 'Gerber over NT', calls: [b(1, 4), PASS], candidate: b(4, 0), title: 'Gerber', artificial: true },
  { name: 'quantitative 4NT', calls: [b(1, 4), PASS], candidate: b(4, 4), title: 'Quantitative' },
  { name: 'Stayman over 2NT', calls: [b(2, 4), PASS], candidate: b(3, 0), title: 'Stayman', artificial: true },
  { name: 'Stayman response: no major', dealer: 2, calls: [b(1, 4), PASS, b(2, 0), PASS], candidate: b(2, 1), title: 'no major', artificial: true },
  { name: 'Stayman response: shows a major', dealer: 2, calls: [b(1, 4), PASS, b(2, 0), PASS], candidate: b(2, 2), title: 'Stayman response', artificial: true },
  { name: 'accepts transfer to hearts', dealer: 2, calls: [b(1, 4), PASS, b(2, 1), PASS], candidate: b(2, 2), title: 'Accepts the transfer', artificial: true },
  { name: 'accepts transfer to spades', dealer: 2, calls: [b(1, 4), PASS, b(2, 2), PASS], candidate: b(2, 3), title: 'Accepts the transfer', artificial: true },
  { name: 'super-accept of transfer', dealer: 2, calls: [b(1, 4), PASS, b(2, 2), PASS], candidate: b(3, 3), title: 'Super-accept', artificial: true },
  { name: 'Gerber response: 0 or 4 aces', dealer: 2, calls: [b(1, 4), PASS, b(4, 0), PASS], candidate: b(4, 1), title: 'Gerber response', artificial: true },
  { name: 'Gerber response: 2 aces', dealer: 2, calls: [b(1, 4), PASS, b(4, 0), PASS], candidate: b(4, 3), title: 'Gerber response', artificial: true },

  // ---- strong 2♣ machinery ----
  { name: '2♦ waiting', calls: [b(2, 0), PASS], candidate: b(2, 1), title: '2♦ waiting', artificial: true },
  { name: 'positive response to 2♣', calls: [b(2, 0), PASS], candidate: b(2, 3), title: 'Positive response', points: '8+ pts' },
  { name: 'opener rebid after 2♦ waiting: suit', calls: [b(2, 0), PASS, b(2, 1), PASS], candidate: b(2, 2), title: 'Rebid after 2♣', points: '22+ pts', forcing: 'game' },
  { name: 'opener rebid after 2♦ waiting: balanced', calls: [b(2, 0), PASS, b(2, 1), PASS], candidate: b(2, 4), title: 'Rebid after 2♣', points: '22+ HCP', forcing: 'game' },

  // ---- weak two machinery ----
  { name: '2NT feature ask', calls: [b(2, 2), PASS], candidate: b(2, 4), title: '2NT over a weak two', artificial: true },
  { name: 'RONF raise', calls: [b(2, 2), PASS], candidate: b(3, 2), title: 'Raise of the preempt' },
  { name: 'feature response: minimum', calls: [b(2, 2), PASS, b(2, 4), PASS], candidate: b(3, 2), title: 'Feature response: minimum' },
  { name: 'feature response: shows a feature', calls: [b(2, 2), PASS, b(2, 4), PASS], candidate: b(3, 0), title: 'Feature response', artificial: true },
  { name: '3NT after feature ask', calls: [b(2, 2), PASS, b(2, 4), PASS], candidate: b(3, 4), title: '3NT after feature ask' },

  // ---- fourth suit forcing ----
  { name: 'fourth suit forcing', calls: [b(1, 0), PASS, b(1, 1), PASS, b(1, 2), PASS], candidate: b(1, 3), title: 'Fourth-suit forcing', artificial: true, forcing: 'one-round' },
  { name: 'new suit rebid is not fourth-suit forcing with only 2 suits shown', dealer: 2, calls: [b(1, 1), PASS, b(1, 3), PASS], candidate: b(2, 2), title: 'Reverse' },

  // ---- Blackwood ----
  { name: 'Blackwood 4NT', calls: [b(1, 3), PASS, b(3, 3), PASS], candidate: b(4, 4), title: 'Blackwood', artificial: true },
  { name: 'Blackwood 5♦ = 1 ace', dealer: 2, calls: [b(1, 3), PASS, b(3, 3), PASS, b(4, 4), PASS], candidate: b(5, 1), title: 'Blackwood response', artificial: true },

  // ---- competitive ----
  { name: 'takeout double', calls: [b(1, 2)], candidate: DOUBLE, title: 'Takeout double', artificial: true, forcing: 'one-round' },
  { name: 'negative double', calls: [b(1, 1), b(1, 3)], candidate: DOUBLE, title: 'Negative double', artificial: true },
  { name: 'penalty double high level', calls: [b(4, 3)], candidate: DOUBLE, title: 'Penalty double' },
  { name: 'one-level overcall', calls: [b(1, 0)], candidate: b(1, 3), title: 'One-level overcall', points: '8–16 pts' },
  { name: 'two-level overcall', calls: [b(1, 3)], candidate: b(2, 2), title: 'Two-level overcall', points: '10–16 pts' },
  { name: '1NT overcall', calls: [b(1, 2)], candidate: b(1, 4), title: '1NT overcall', points: '15–18 HCP' },
  { name: 'weak jump overcall', calls: [b(1, 0)], candidate: b(2, 3), title: 'Weak jump overcall', points: '5–11 HCP' },
  { name: 'Michaels cue-bid', calls: [b(1, 2)], candidate: b(2, 2), title: 'Michaels', artificial: true },
  { name: 'redouble shows 10+', calls: [b(1, 3), DOUBLE], candidate: REDOUBLE, title: 'Redouble', points: '10+ HCP' },
  { name: 'advance of takeout double: minimum', calls: [b(1, 2), DOUBLE, PASS], candidate: b(1, 3), title: 'Response to double', points: '0–8 pts' },
  { name: 'advance of takeout double: jump', calls: [b(1, 2), DOUBLE, PASS], candidate: b(2, 3), title: 'Jump response to double', points: '9–11 pts' },
  { name: 'advance of takeout double: cue-bid', calls: [b(1, 2), DOUBLE, PASS], candidate: b(2, 2), title: 'Cue-bid of the double', points: '12+ pts', artificial: true, forcing: 'game' },
  { name: 'advance of takeout double: 1NT', calls: [b(1, 2), DOUBLE, PASS], candidate: b(1, 4), title: '1NT response to double', points: '8–10 pts' },

  // ---- opener rebids ----
  { name: '1NT rebid 12–14', dealer: 2, calls: [b(1, 0), PASS, b(1, 3), PASS], candidate: b(1, 4), title: '1NT rebid', points: '12–14 HCP' },
  { name: '2NT jump rebid 18–19', dealer: 2, calls: [b(1, 0), PASS, b(1, 3), PASS], candidate: b(2, 4), title: '2NT jump rebid', points: '18–19 HCP' },
  { name: 'reverse', dealer: 2, calls: [b(1, 1), PASS, b(1, 3), PASS], candidate: b(2, 2), title: 'Reverse', points: '17+ pts' },
  { name: 'raise of responder', dealer: 2, calls: [b(1, 1), PASS, b(1, 3), PASS], candidate: b(2, 3), title: 'Raise of responder' },
  { name: 'minimum suit rebid', dealer: 2, calls: [b(1, 3), PASS, b(2, 1), PASS], candidate: b(2, 3), title: 'Rebid of your suit', points: '13–15 pts' },

  // ---- honest fallbacks ----
  { name: 'exotic sequence falls back honestly', calls: [b(1, 0), b(1, 3), b(2, 1), PASS], candidate: b(3, 0), exact: false },
  { name: 'weird high opening falls back', calls: [], candidate: b(5, 0), exact: false },
];

describe('SAYC explainer spec table', () => {
  for (const row of SPEC) {
    it(row.name, () => {
      const meaning = explainBid(row.dealer ?? 0, row.calls, row.candidate);
      expect(meaning, 'meaning should exist').not.toBeNull();
      if (row.title) expect(meaning!.title).toContain(row.title);
      if (row.points) expect(meaning!.points).toBe(row.points);
      if (row.artificial !== undefined) expect(Boolean(meaning!.artificial)).toBe(row.artificial);
      if (row.forcing !== undefined) expect(meaning!.forcing ?? null).toBe(row.forcing);
      expect(meaning!.exact).toBe(row.exact ?? true);
      expect(meaning!.description.length).toBeGreaterThan(20);
    });
  }

  it('returns null once the auction is over', () => {
    expect(explainBid(0, [PASS, PASS, PASS, PASS], PASS)).toBeNull();
  });
});
