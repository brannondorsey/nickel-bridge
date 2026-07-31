import { describe, expect, it, vi } from 'vitest';
import { freshDbEnv } from './helpers.js';

freshDbEnv('play-precision-failure');

/**
 * Isolates ONLY the completion-time solveFutureTricks call — the raw,
 * empty-plays "declarer ceiling" solve capturePlayPrecision (server/src/
 * game.ts) runs, and nothing else — so this file can prove its try/catch is
 * load-bearing: a solve failure there must never prevent save() from
 * persisting the human's just-submitted call/card.
 *
 * advanceRobots's own claim-gate solve at the VERY FIRST play-phase decision
 * point (the opening lead, before any card is played) ALSO passes an empty
 * plays array — it's the only other call site that ever does — so an empty
 * array alone can't tell the two calls apart. Call ORDER can: within one
 * board's whole life, a plays.length === 0 solve happens at most twice — once
 * for that opening-lead check (whether or not it fires a claim: a claim
 * pushes a card immediately, so plays is never empty again after it), and
 * once, after the board is otherwise fully resolved, for
 * capturePlayPrecision. Letting the FIRST such call through untouched and
 * failing every one after it therefore hits exactly (and only)
 * capturePlayPrecision's call.
 */
let emptyPlaysCalls = 0;
vi.mock('@bridge/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bridge/ai')>();
  return {
    ...actual,
    solveFutureTricks: async (...args: Parameters<typeof actual.solveFutureTricks>) => {
      const plays = args[2];
      if (plays.length === 0) {
        emptyPlaysCalls++;
        if (emptyPlaysCalls > 1) throw new Error('simulated DDS failure');
      }
      return actual.solveFutureTricks(...args);
    },
  };
});

const { db } = await import('../src/db.js');
const game = await import('../src/game.js');

function makeTournament(seed: string) {
  return db.prepare(`INSERT INTO tournaments (name, seed) VALUES ('t', ?) RETURNING *`).get(seed) as any;
}

describe('capturePlayPrecision failure is best-effort (server/src/game.ts)', () => {
  it('a completion-time solve failure leaves dd_declarer_tricks null but still saves the board', async () => {
    const userId = (
      db.prepare(`INSERT INTO users (google_id, name) VALUES ('dev:tester','Tester') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    // 'hunt-1' board 2: North declares, deterministic score_ns=170 (same
    // pinned seed/board as game.test.ts's "declarer scenarios" suite) —
    // reaches a contract, so capturePlayPrecision actually runs.
    const t = makeTournament('hunt-1');
    const b = game.loadBoard(t, userId, 2, true)!;
    // Mirrors the real GET-board route (app.ts), which calls ensureAdvanced
    // before ever handing a view back to the client: a freshly loaded board
    // may not have the human on lead (dealer can be any seat), so without
    // this the very first view can have no legal action for South and the
    // loop below finds itself stuck before a single human decision is made.
    await game.ensureAdvanced(b);
    let view = game.boardView(t, b, 1200) as any;
    let safety = 250;
    while (view.state !== 'done' && safety-- > 0) {
      if (view.state === 'bidding' && view.myTurn) await game.submitCall(b, 0);
      else if (view.state === 'playing' && view.myTurn) await game.submitPlay(b, view.legalCards[0]);
      else throw new Error(`stuck: ${view.state} myTurn=${view.myTurn}`);
      view = game.boardView(t, b, 1200) as any;
    }

    // The human's own final action landed and the board completed despite
    // the completion-time solve throwing on the way — the try/catch inside
    // capturePlayPrecision never blocked save().
    expect(b.row.state).toBe('done');
    expect(b.contract).not.toBeNull();
    expect(b.row.score_ns).toBe(170); // same deterministic outcome as the unmocked path
    expect(b.row.dd_declarer_tricks).toBeNull();
    // Confirms the mock actually reached and failed capturePlayPrecision's
    // call, rather than this test vacuously passing because the mock never
    // fired a second time.
    expect(emptyPlaysCalls).toBeGreaterThan(1);
  });
});
