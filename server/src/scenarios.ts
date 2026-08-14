/**
 * The demo-mode scenario catalog ("exhibits"): replay recipes that land a
 * board in a precise, hard-to-reach state so preview testers can jump
 * straight to it from the /scenarios gallery.
 *
 * A recipe is (seed, boardNo, human actions). Deals derive deterministically
 * from the seed and robots are deterministic (CLAUDE.md invariant 1), so
 * replaying the actions through the real engine always reproduces the same
 * state. Delta-driven UI (grade toast, claim announcement + fast-forward, the live
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
type ScenarioCategory = 'bidding' | 'card play' | 'claims' | 'scoring' | 'results' | 'the field';

interface ScenarioAction {
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
  /**
   * This exhibit PROMISES a claim on the tester's next action — the ticket, the
   * announcement hold, the fast-forward. `expect` can't express that: it
   * describes the board one action BEFORE the payoff, so a recipe that still
   * arrives in the right state while no longer claiming passes the drift guard
   * in silence. It is not a hypothetical failure — the pessimistic claim gate
   * (db.ts's claim_rule migration) broke exactly these two exhibits without
   * reddening a single test. Set it wherever the description says "claim" and
   * scenarios.test.ts will play out that final action, on its own replay, for
   * every legal card.
   *
   * Which value matters, because under the pessimistic gate whether a claim
   * fires can depend on WHICH card the tester picks:
   *   'all' — every legal final card claims, so the copy may safely invite
   *           them to play any of them.
   *   'any' — at least one does. The copy MUST then name the card, or a tester
   *           following it lands on a board that just keeps playing.
   */
  expectClaimOnFinalAction?: 'any' | 'all';
  /**
   * Override the exhibit tournament's claim_rule (default: the column's, i.e.
   * the shipped 'pessimistic' gate). Exactly one exhibit sets this, and only
   * because the state it demonstrates is unreachable without it — see
   * 'claim-on-call'. Everything else takes the default, the same way exhibits
   * take difficulty='perfect'.
   */
  claimRule?: 'optimistic' | 'pessimistic';
  /**
   * This is the tournament's last board, and finishing it live should reveal
   * a genuine tournament-summary screen — not just this one board's receipt.
   * The executor pre-completes the acting user's boards 1..(boardNo - 1)
   * first (see demo.ts's runScenarioNow), and the seeder pre-plays
   * `fieldBots` through every board instead of just this one (demo-seed.ts),
   * so there's a real field to rank against when the tester's last play
   * finishes both the board and the tournament in the same live response.
   */
  completesTournament?: boolean;
  /**
   * Not a replay recipe: each click creates a brand-new STANDARD tournament
   * (kind 'standard', ai_field = 1 — exhibit-kind tournaments deliberately
   * never get AI rows) with a random per-click seed, and lands the tester at
   * board 1. This is the live path for click-testing the benchmark AI
   * personas exactly as production behaves: the house sets off behind the
   * tester on demand (ai-players.ts scheduling). `seed` is only the random
   * seed's prefix here, `actions` must be empty, and `expect` is 'bidding'
   * (South always gets a call before an auction can end, so the state after
   * ensureAdvanced is seed-independent — which is what keeps the drift guard
   * meaningful for this entry).
   */
  freshAiField?: boolean;
  /**
   * Milliseconds after the tester lands to move this board on BEHIND them,
   * via POST /api/demo/desync — one real play through the real engine, which
   * is exactly what a second tab or a second device does.
   *
   * The only exhibit flag the executor ignores: the recipe here is an
   * ordinary one, and what makes the state reachable happens on the CLIENT
   * (Scenarios.tsx schedules the call, then navigates). It has to, because
   * this state is the one thing a replay recipe cannot produce — a refused
   * play needs the screen to be BEHIND the server, and Board.tsx GETs the
   * board fresh on mount, so any staleness baked in before the navigation is
   * gone by the time the tester sees it. The desync therefore has to land
   * after that GET, which is why it is a timer rather than a step in the
   * recipe. The delay is generous on purpose: the tester still has to read
   * the board and tap twice (select, then confirm), so beating it means
   * tapping blind — and if they do, the play simply succeeds and the exhibit
   * can be re-entered.
   */
  desyncAfterMs?: number;
}

const call = (value: number): ScenarioAction => ({ kind: 'call', value });
const card = (value: number): ScenarioAction => ({ kind: 'card', value });

export const SCENARIOS: Scenario[] = [
  // ---- bidding ----
  {
    id: 'your-call',
    label: 'An opening bid, your call',
    description:
      'A fresh deal with the auction already under way — the three calls made before you sat down drop onto the tray one at a time as the board opens. Tap calls in the bid box to read their SAYC meanings before you commit, then watch the robots answer the same way.',
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
      'The auction stands at 2♥ by your partner. Pass, and the rest follows in order: your bid is graded, the tray fills out, then the board flips and the opening lead is staged into play. This is also the click-test for “Trump placement” — turn it to LEFT SIDE on the settings gate first and the hearts are drawn out of the fan one at a time, into the gap the other suits open, before the lead lands.',
    category: 'bidding',
    seed: 'hunt-1',
    boardNo: 2,
    actions: [call(0), call(0)],
    expect: 'bidding',
  },
  {
    id: 'passed-out',
    label: 'All four hands pass',
    description:
      'Two passes drop onto the tray as the board opens. Pass yourself and the board is thrown in — no contract, no toll — with your grade stamped on the way out.',
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
      'North wins the auction at 2♥, so you run the play from partner’s seat: the compass turns, North’s cards come to your hand, and your own South hand is tabled as dummy.',
    category: 'card play',
    seed: 'hunt-1',
    boardNo: 2,
    actions: [call(0), call(0), call(0)],
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
    id: 'stale-board',
    label: 'A second device moves the board on',
    description:
      'Give it a moment when you arrive — another session plays a card behind your back, exactly as a second tab of your own would. Then tap any card: the server refuses it, the fan locks, and the notice under it says the board is resyncing until the true position lands.',
    category: 'card play',
    // Deliberately the same (seed, board, actions) as 'west-declares': the
    // recipe is not what this exhibit is about, and re-entering either one
    // wipes and replays the board row (runScenarioNow), which is how two
    // scenarios share a board. Reusing an already-verified triple also keeps
    // this off tools/find_scenarios.mjs — there was no new position to mine.
    seed: 'demo-0',
    boardNo: 2,
    actions: [call(0), call(0), call(0)],
    expect: 'playing',
    desyncAfterMs: 1500,
  },
  {
    id: 'sole-legal',
    label: 'Only one card to play',
    description:
      'Clubs are live and you are down to the forced ♣J. Watch it mark itself and pay the trick on its own — no tap required.',
    category: 'card play',
    seed: 'hunt-1',
    boardNo: 2,
    actions: [call(0), call(0), call(0), card(40)],
    expect: 'playing',
  },

  // ---- claims ----
  {
    id: 'claim-fires',
    label: 'The defense claims the rest',
    description:
      'Your doubled 1NT is five light and the defense can prove the rest. Play the ♣9 — the claim ticket goes up over the last three tricks, then the fast-forward runs the board out to a very expensive score. (Take the ♣K instead and there is no ticket: that line is still live, which is the point of the gate.)',
    category: 'claims',
    seed: 'hunt-6',
    boardNo: 1,
    actions: [
      call(7),
      call(0),
      card(28),
      card(27),
      card(44),
      card(41),
      card(5),
      card(1),
      card(9),
      card(2),
      card(17),
      card(14),
      card(45),
      card(49),
      card(6),
      card(16),
      card(18),
      card(19),
      card(29),
      card(8),
      card(11),
      card(30),
    ],
    expect: 'playing',
    expectClaimOnFinalAction: 'any', // only the ♣9; the ♣K plays on
  },

  {
    id: 'claim-on-call',
    label: 'A claim before you play a card',
    description:
      'Your last pass ends the auction — and that is the whole board. West holds 3NT cold from the first card, so the claim ticket goes up before you have played anything, and the fast-forward runs all thirteen tricks onto the receipt. (A LEGACY tournament: today’s gate only claims once no card anyone plays could change the result, and that is almost never true this early. Older tournaments still use the gate that claimed on double dummy alone, and this is what that looks like.)',
    category: 'claims',
    seed: 'callclaim-38',
    boardNo: 1,
    // Two passes in; the tester's third ends the auction and triggers it.
    actions: [call(0), call(0)],
    expect: 'bidding',
    expectClaimOnFinalAction: 'all',
    // The one exhibit that overrides the rule, and it has to: a scan of 522
    // call actions found a claim arriving on a CALL three times under
    // 'optimistic' and NEVER under 'pessimistic'. The client path it
    // exercises (submitCall → runClaim → the announcement) is identical
    // either way, and legacy tournaments are still live and resumable, so
    // this is a real production state rather than a staged one.
    claimRule: 'optimistic',
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

  // ---- results ----
  {
    id: 'tournament-complete',
    label: 'A tournament, paid in full',
    description:
      'Board 4 of 4, one card left. Play it and the receipt prints — then, because it’s the last board, TOURNAMENT SUMMARY unlocks: match percentage, rank, every board’s toll, and the final field, all on one page. Each ledger line taps back into that board. (No rating line: exhibits never rate, same as any unrated tournament — not a bug.)',
    category: 'results',
    seed: 'finale-1',
    boardNo: 4,
    actions: [
      call(0),
      call(0),
      card(0),
      card(31),
      card(45),
      card(51),
      card(4),
      card(18),
      card(32),
      card(6),
      card(35),
      card(20),
      card(11),
      card(12),
    ],
    expect: 'playing',
    fieldBots: 3,
    completesTournament: true,
  },
  {
    id: 'analyze-play',
    label: 'The audit of a crossing',
    description:
      'Four diamonds left, and the position is already settled — play any of them and the claim fast-forwards the last four tricks onto the receipt. Then take ANALYZE PLAY on the result: this line leaked real matchpoints, and WHERE IT TURNED shows exactly which cards were findable from your seat and missed — a card only double dummy would have found makes no appearance at all. (Mined so the audit has something to say — several moments clear the floor here.)',
    category: 'results',
    seed: 'analyze-demo-b',
    boardNo: 1,
    actions: [
      call(0),
      call(0),
      call(0),
      card(15),
      card(6),
      card(8),
      card(39),
      card(26),
      card(19),
      card(21),
      card(23),
      card(50),
    ],
    expect: 'playing',
    expectClaimOnFinalAction: 'all',
    fieldBots: 3,
  },

  // ---- the field ----
  {
    id: 'fresh-house-crossing',
    label: 'A fresh crossing with the house',
    description:
      'Opens a brand-new tournament with the three house players — The Novice, The Regular, The Shark — setting off right behind you. Score board 1 and the receipt ranks you among them; The Field fills in as they cross. Every visit opens a fresh one.',
    category: 'the field',
    seed: 'fresh-house',
    boardNo: 1,
    actions: [],
    expect: 'bidding',
    freshAiField: true,
  },
];

export const scenarioById = new Map(SCENARIOS.map((s) => [s.id, s]));

/** Exhibit tournaments are recognized by name (see tournaments.ts placement filter). */
export const exhibitName = (seed: string): string => `Exhibit: ${seed}`;
