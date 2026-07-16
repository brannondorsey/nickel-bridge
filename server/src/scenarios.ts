/**
 * The demo-mode scenario catalog ("exhibits"): replay recipes that land a
 * board in a precise, hard-to-reach state so preview testers can jump
 * straight to it from the /scenarios gallery.
 *
 * A recipe is (seed, boardNo, human actions). Deals derive deterministically
 * from the seed and robots are deterministic (CLAUDE.md invariant 1), so
 * replaying the actions through the real engine always reproduces the same
 * state. Delta-driven UI (grade toast, claim banner + fast-forward, the live
 * toll receipt, staged trick animation) only appears on a live response
 * transition, so recipes deliberately stop ONE human action short of the
 * trigger — the description tells the tester what final step to take.
 *
 * Recipes were derived with `tools/find_scenarios.mjs` (offline; see its
 * header) and are replay-sensitive the same way the robot-trace fixture is:
 * a deliberate robot change (model, tie-breaks, dealing) breaks them, and
 * server/test/scenarios.test.ts fails. Re-derive with the tool, then curate
 * labels by hand — labels and descriptions are tester-facing copy.
 */

// Extending this union is all a new gallery section needs — the frontend
// derives section order from catalog order, so no web change is required.
export type ScenarioCategory = 'bidding' | 'card play' | 'claims' | 'scoring';

export interface ScenarioAction {
  kind: 'call' | 'card';
  value: number;
}

export interface Scenario {
  /** stable slug — the POST /api/demo/scenarios/:id route param */
  id: string;
  /** gallery button copy, tester-facing, toll voice */
  label: string;
  /** what the tester will see, and the final action to take */
  description: string;
  category: ScenarioCategory;
  /** literal tournament seed — deals derive from it, so never rename */
  seed: string;
  boardNo: number;
  /** scripted HUMAN actions, replayed in order through the real engine */
  actions: ScenarioAction[];
  /** board state after replay — the executor 500s (and CI fails) on drift */
  expect: 'bidding' | 'playing' | 'done';
  /** seeder pre-plays this many bots through the SAME board, so completing it live shows a real matchpoint field */
  fieldBots?: number;
}

const call = (value: number): ScenarioAction => ({ kind: 'call', value });
const card = (value: number): ScenarioAction => ({ kind: 'card', value });

export const SCENARIOS: Scenario[] = [
  // ---- bidding ----
  {
    id: 'your-call',
    label: 'An opening bid, your call',
    description:
      'A fresh deal with the auction to you. Tap calls in the bid box to read their SAYC meanings before you commit — the robots answer in kind.',
    category: 'bidding',
    seed: 'hunt2-2',
    boardNo: 4,
    actions: [],
    expect: 'bidding',
  },
  {
    id: 'pass-ends-auction',
    label: 'Your pass seals the contract',
    description:
      'The auction stands at 3♣ by your partner. Pass, and everything lands at once: your bid is graded, the board flips, and the opening lead is staged into play.',
    category: 'bidding',
    seed: 'hunt-0',
    boardNo: 3,
    actions: [call(0)],
    expect: 'bidding',
  },
  {
    id: 'passed-out',
    label: 'All four hands pass',
    description:
      'Three passes on the tray already. Pass yourself and the board is thrown in — no contract, no toll — with your grade stamped on the way out.',
    category: 'bidding',
    seed: 'hunt-1',
    boardNo: 1,
    actions: [],
    expect: 'bidding',
  },

  // ---- card play ----
  {
    id: 'partner-declares',
    label: 'Partner declares — the board flips',
    description:
      'North wins the auction at 3♣, so you run the play from partner’s seat: the compass turns, North’s cards come to your hand, and your own South hand is tabled as dummy.',
    category: 'card play',
    seed: 'hunt-0',
    boardNo: 3,
    actions: [call(0), call(0)],
    expect: 'playing',
  },
  {
    id: 'defend-doubled',
    label: 'On lead against a doubled contract',
    description:
      'East plays 2♦ doubled and you are on opening lead. Dummy racks up on the side rail once your card hits the felt — defend as you see fit.',
    category: 'card play',
    seed: 'hunt-0',
    boardNo: 1,
    actions: [call(0), call(0)],
    expect: 'playing',
  },
  {
    id: 'west-declares',
    label: 'Dummy on the other rail',
    description:
      'West plays 1NT, so dummy is tabled on the right-hand rail this time — the mirror of the doubled defense next door. You defend from South as usual.',
    category: 'card play',
    seed: 'demo-0',
    boardNo: 2,
    actions: [call(0), call(0), call(0)],
    expect: 'playing',
  },
  {
    id: 'sole-legal',
    label: 'Only one card to play',
    description:
      'Spades are live and you are down to the forced ♠7. Watch it mark itself and pay the trick on its own — no tap required.',
    category: 'card play',
    seed: 'hunt-0',
    boardNo: 3,
    actions: [call(0), call(0), card(0)],
    expect: 'playing',
  },

  // ---- claims ----
  {
    id: 'claim-fires',
    label: 'The defense claims the rest',
    description:
      'Your 1NT is going down and the robots can prove it. Play the ♦4 and the claim banner goes up while the remaining tricks fast-forward to the score.',
    category: 'claims',
    seed: 'hunt2-2',
    boardNo: 4,
    actions: [
      call(7),
      card(5),
      card(7),
      card(45),
      card(40),
      card(14),
      card(15),
      card(20),
      card(6),
      card(9),
      card(21),
      card(26),
      card(22),
      card(34),
      card(10),
      card(47),
      card(43),
      card(35),
    ],
    expect: 'playing',
  },

  // ---- scoring ----
  {
    id: 'toll-receipt',
    label: 'A toll receipt, doubled',
    description:
      'One trick left against 2♦ doubled. Play out your hand and the receipt prints line by line — insult and all — against a field of three.',
    category: 'scoring',
    seed: 'hunt-0',
    boardNo: 1,
    actions: [
      call(0),
      call(0),
      card(4),
      card(31),
      card(16),
      card(18),
      card(40),
      card(6),
      card(41),
      card(34),
      card(36),
    ],
    expect: 'playing',
    fieldBots: 3,
  },
];

export const scenarioById = new Map(SCENARIOS.map((s) => [s.id, s]));

/** Exhibit tournaments are recognized by name (see tournaments.ts placement filter). */
export const exhibitName = (seed: string): string => `Exhibit: ${seed}`;
